# Fix: Zoho Cliq adapter drops all messages when operator uses personal OAuth credentials

## Problem Statement

The Zoho Cliq channel adapter (`src/channels/zoho-cliq.ts`) has a self-message filter at line 180 that unconditionally drops every message whose `sender.id` matches the adapter's authenticated `currentUserId`:

```typescript
// Line 180
if (msg.sender.id === currentUserId) continue;
```

This filter exists to prevent the agent from picking up its own outbound replies as new inbound messages (echo loop). However, it breaks completely when the adapter authenticates with the **operator's personal Zoho OAuth credentials** rather than a dedicated bot/service account — because the operator's `sender.id` and the adapter's `currentUserId` are identical.

### Observed behavior

- Adapter authenticates as `userId: 922200941` (the operator's Zoho account).
- Operator sends a message in the configured Cliq channel.
- Cliq API returns the message with `msg.sender.id = "922200941"`.
- Line 180 matches: `"922200941" === "922200941"` → message skipped.
- **Result**: every message the operator sends is silently dropped. The inbound session DB (`messages_in`) never receives any user messages from Cliq. Only system-injected messages (like `/welcome`) appear, because those bypass the adapter poll entirely.

### Why this is common

NanoClaw setup does not require a separate bot account for Cliq. The operator's own OAuth refresh token (`ZOHO_CLIQ_REFRESH_TOKEN`) is the natural first credential to configure. There is no warning that using personal credentials causes the self-filter to eat all inbound messages.

### Scope

This affects **only** the Zoho Cliq adapter. Other channel adapters (Discord, Slack, Telegram, etc.) authenticate as bot accounts by design, so their self-filter works correctly.

---

## Root Cause

The self-filter uses **sender identity** as a proxy for "this is my own outbound message." That proxy is only valid when the adapter's identity differs from every human user's identity. When they overlap (personal OAuth), the filter becomes a blanket block on the operator's messages.

---

## Fix

Replace the sender-identity filter with an **outbound-message-ID filter**. The adapter already knows exactly which messages it sent — they are in the delivery path. Track recently-delivered outbound message IDs and skip only those, not everything from a matching sender.

### File to change

`src/channels/zoho-cliq.ts`

### Implementation

#### 1. Add a sent-message tracker (near the top of the adapter closure, around line 20-30 where `lastSeenTime` and other state is declared)

```typescript
/**
 * Track Cliq platform message IDs that WE delivered, so the poll loop can
 * skip them without relying on sender-identity matching. This lets the
 * adapter work correctly even when authenticated as the operator's own
 * Zoho account (where sender.id === currentUserId for human messages too).
 *
 * Entries are evicted after 5 minutes to bound memory.
 */
const sentMessageIds = new Map<string, number>(); // platformMsgId → timestamp
const SENT_ID_TTL_MS = 5 * 60 * 1000;
```

#### 2. Record outbound message IDs after successful delivery

In the `send` / `deliver` function (the part of the adapter that posts messages to the Cliq API and returns a `platformMsgId`), add a line after a successful send:

```typescript
// After successfully posting a message and receiving the platform message ID:
sentMessageIds.set(platformMsgId, Date.now());
```

Find the `send` method in the `ChannelAdapter` implementation (around line 210+). It calls the Cliq API to post a message and returns a result containing `platformMsgId`. After that API call succeeds, record the ID.

#### 3. Replace the self-filter in `pollMessages` (line 178-182)

**Before:**
```typescript
for (const msg of messages) {
  // Skip bot's own messages
  if (msg.sender.id === currentUserId) continue;
  // Only process text messages (skip system/info/file messages for now)
  if (msg.type !== 'text' || !msg.content.text) continue;
```

**After:**
```typescript
// Evict stale entries from the sent-message tracker
const now = Date.now();
for (const [id, ts] of sentMessageIds) {
  if (now - ts > SENT_ID_TTL_MS) sentMessageIds.delete(id);
}

for (const msg of messages) {
  // Skip messages WE delivered (by platform message ID, not sender identity).
  // This replaces the old `msg.sender.id === currentUserId` check, which
  // broke when the adapter authenticates as the operator's personal account.
  if (sentMessageIds.has(msg.id)) continue;
  // Only process text messages (skip system/info/file messages for now)
  if (msg.type !== 'text' || !msg.content.text) continue;
```

#### 4. (Optional but recommended) Keep sender-filter as a secondary guard

If you want belt-and-suspenders protection against echo loops in case the platform message ID format changes or delivery doesn't return an ID, you can keep the sender check but only apply it to messages that were sent very recently (within the last few seconds):

```typescript
// Secondary guard: if the message is from our userId AND was sent in the
// last 10 seconds, it's likely our own delivery that we didn't track.
// This is a fallback — the primary filter is sentMessageIds above.
if (msg.sender.id === currentUserId) {
  const msgAge = Date.now() - msg.time;
  if (msgAge < 10_000) continue;
}
```

This allows old messages from the operator (i.e., genuine human messages) to pass through while still catching rapid echo from fresh outbound deliveries that might have been missed by the ID tracker.

### Testing

1. **With personal OAuth credentials**: Send a message in the configured Cliq channel. Verify it appears in `messages_in` for the Cliq session:
   ```bash
   sqlite3 -header data/v2-sessions/ag-1777966376433-v04151/sess-1777966376446-wd81gp/inbound.db \
     "SELECT seq, timestamp, status, substr(content,1,80) FROM messages_in ORDER BY seq DESC LIMIT 5;"
   ```
   Before the fix: only system messages. After the fix: user messages appear.

2. **Echo prevention**: After the agent replies in Cliq, verify the agent's own reply does NOT get re-ingested as a new inbound message (which would cause an infinite loop). Check that `sentMessageIds` contains the delivered platform message ID by adding a debug log.

3. **With a bot account** (if available): Verify existing behavior is preserved — the sender-identity check was correct for bot accounts and the new logic should be a strict superset.

### Key context for the implementing agent

- The adapter file is `src/channels/zoho-cliq.ts` — it lives on trunk (not a branch-installed channel).
- The `send` method is part of the `ChannelAdapter` interface implementation starting around line 210.
- `platformMsgId` is the Cliq-side message ID returned after a successful POST. It's the same ID format that appears in poll responses as `msg.id`.
- The host process runs on Node (not Bun). Use `Map` for the tracker — it's fine for this scale.
- After editing, rebuild with `pnpm run build` and restart the service:
  ```bash
  launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-8e953878
  ```
- The Zoho Cliq adapter polls every ~60 seconds (`POLL_INTERVAL_MS`). After restart, send a test message in Cliq and wait up to 60s for it to appear.

---

## Alternative (long-term)

Create a dedicated Zoho bot/service account for the adapter. This makes the sender-identity filter work correctly without code changes. However, not all Zoho plans support service accounts or bot users, and the current setup flow doesn't guide users toward this — so the code-level fix above is necessary regardless.