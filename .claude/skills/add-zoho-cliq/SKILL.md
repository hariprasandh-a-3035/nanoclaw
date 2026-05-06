---
name: add-zoho-cliq
description: Add Zoho Cliq channel integration. Native polling adapter — no Chat SDK bridge. Supports DMs, group chats, and channels via Zoho Cliq REST API v2 with OAuth2.
---

# Add Zoho Cliq Channel

Adds Zoho Cliq support via a native polling adapter using the Zoho Cliq REST API v2.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Zoho Cliq adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/zoho-cliq.ts` exists
- `src/channels/index.ts` contains `import './zoho-cliq.js';`
- `setup/channels/zoho-cliq.ts` exists
- `setup/add-zoho-cliq.sh` exists
- `setup/install-zoho-cliq.sh` exists
- `setup/auto.ts` imports `runZohoCliqChannel` from `./channels/zoho-cliq.js`
- `setup/auto.ts` includes `'zoho-cliq'` in `ChannelChoice`
- `setup/auto.ts` includes picker option `{ value: 'zoho-cliq', label: 'Yes, connect Zoho Cliq' }`
- `setup/auto.ts` dispatches `channelChoice === 'zoho-cliq'` to `runZohoCliqChannel(displayName!)`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy files from the channels branch

```bash
git show origin/channels:src/channels/zoho-cliq.ts > src/channels/zoho-cliq.ts
git show origin/channels:setup/channels/zoho-cliq.ts > setup/channels/zoho-cliq.ts
git show origin/channels:setup/add-zoho-cliq.sh > setup/add-zoho-cliq.sh
git show origin/channels:setup/install-zoho-cliq.sh > setup/install-zoho-cliq.sh
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './zoho-cliq.js';
```

### 4. Wire the setup auto-picker

Add the following to `setup/auto.ts` (skip any that are already present):

**Import** (with the other channel imports near the top):
```typescript
import { runZohoCliqChannel } from './channels/zoho-cliq.js';
```

**ChannelChoice type** — add `'zoho-cliq'` to the union:
```typescript
type ChannelChoice = '...' | 'zoho-cliq' | 'skip';
```

**Picker option** — add to the channel select prompt's options array:
```typescript
{ value: 'zoho-cliq', label: 'Yes, connect Zoho Cliq' },
```

**Dispatch branch** — add an `else if` in the channel-run block:
```typescript
} else if (channelChoice === 'zoho-cliq') {
  await runZohoCliqChannel(displayName!);
}
```

**DM label** (optional) — add to `channelDmLabel()` switch:
```typescript
case 'zoho-cliq':
  return 'Zoho Cliq';
```

### 5. Build

```bash
pnpm run build
```

No additional npm packages are required — the adapter uses only the Node `fetch` API and existing NanoClaw imports.

## Credentials

### Create a Zoho API Client (Server-based Application)

1. Go to the [Zoho API Console](https://api-console.zoho.com/) (use the domain matching your org — `.com`, `.eu`, `.in`, etc.)
2. Click **Add Client** → **Server-based Applications**
3. Fill in:
   - **Client Name**: e.g. "NanoClaw Cliq"
   - **Homepage URL**: `http://localhost`
   - **Authorized Redirect URI**: `http://localhost:8484/callback`
4. Click **Create** — copy the **Client ID** and **Client Secret**

### Get a Refresh Token (automated OAuth flow)

If running through `/setup` or `/new-setup`, the clack UI will:

1. Collect your Client ID, Client Secret, Cliq API URL, and Chat IDs
2. Start a local HTTP server on port 8484
3. Open your browser to the Zoho consent page
4. Exchange the authorization code for a refresh token automatically

### Manual refresh token (alternative)

If you're not using the interactive setup:

1. Open the authorization URL in your browser (replace values):
   ```
   https://accounts.zoho.com/oauth/v2/auth?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost:8484/callback&scope=ZohoCliq.Webhooks.CREATE,ZohoCliq.Messages.ALL&access_type=offline&prompt=consent
   ```
2. Authorize and copy the `code` parameter from the redirect URL
3. Exchange the code:
   ```bash
   curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
     -d "code=YOUR_CODE" \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "grant_type=authorization_code" \
     -d "redirect_uri=http://localhost:8484/callback"
   ```
4. Copy the `refresh_token` from the response

**Important**: Use the accounts domain that matches your Cliq API URL: `cliq.zoho.in` → `accounts.zoho.in`, `cliq.zoho.eu` → `accounts.zoho.eu`, etc.

### Configure environment

The setup flow will collect these 6 required variables. Add to `.env` if you want to reuse them:

```bash
ZOHO_CLIQ_BOT_UNIQUE_NAME=my_bot
ZOHO_CLIQ_CHANNEL_ENDPOINT=https://cliq.zoho.com/api/v2/channelsbyname/my_channel/message
ZOHO_CLIQ_CHAT_ID=CT_1424358622861866713_922179757
ZOHO_CLIQ_CLIENT_ID=your-client-id
ZOHO_CLIQ_CLIENT_SECRET=your-client-secret
ZOHO_CLIQ_REFRESH_TOKEN=your-refresh-token
```

- `ZOHO_CLIQ_BOT_UNIQUE_NAME` — the bot's unique identifier in Zoho Cliq
- `ZOHO_CLIQ_CHANNEL_ENDPOINT` — the channel message endpoint (from channel info → Connectors)
- `ZOHO_CLIQ_CHAT_ID` — Channel's chat ID to poll
- `ZOHO_CLIQ_CLIENT_ID`, `ZOHO_CLIQ_CLIENT_SECRET` — OAuth app credentials
- `ZOHO_CLIQ_REFRESH_TOKEN` — OAuth refresh token (doesn't expire like access tokens)

**Env reuse**: The setup flow detects existing configuration:
- If **all 6 variables are present**, you'll be asked "Reuse entire config?" (skip all prompts)
- If you decline, each field will offer an individual "Use existing?" prompt
- The Cliq API URL and accounts domain are automatically derived from the channel endpoint, so you don't need to set them

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `zoho-cliq`
- **terminology**: Zoho Cliq has "channels" (topic-based, like Slack channels) and "chats" (DMs or group conversations). Bots are a special chat type.
- **how-to-find-id**: The platform ID format is `zoho-cliq:<chat_id>`. To find the Chat ID: open the chat/channel in Zoho Cliq web, click the info icon → Connectors. The Chat ID is displayed in the channel info panel.
- **supports-threads**: no (Cliq has threads but the adapter treats channels/chats as the primary unit)
- **typical-use**: Interactive chat — DMs, group chats, or organization channels
- **default-isolation**: Same agent group for your personal chats. Separate agent group for channels with different teams or organizational boundaries.
- **polling-based**: This adapter polls Zoho Cliq every 5 seconds for new messages. It does not use webhooks or WebSocket — Zoho Cliq's bot platform uses server-side Deluge handlers rather than HTTP callbacks.
- **rate-limits**: The adapter respects Zoho's API rate limits (15 message reads/min, 30 chats/channels reads/min, 50 message posts/min). It caps per-cycle message polls to 3.

## Troubleshooting

### "Zoho token refresh failed"
- Verify `ZOHO_CLIQ_CLIENT_ID`, `ZOHO_CLIQ_CLIENT_SECRET`, and `ZOHO_CLIQ_REFRESH_TOKEN` are correct
- Ensure `ZOHO_CLIQ_ACCOUNTS_URL` matches your org's data center (e.g. `https://accounts.zoho.in` for India)
- Check that the OAuth client is a "Server-based Application" (not "Client-based")
- The refresh token may have been revoked — re-run setup or regenerate manually

### Bot doesn't see messages
- The authenticated user must be a member of the chat/channel
- Ensure OAuth scopes include `ZohoCliq.Chats.READ` and `ZohoCliq.Messages.READ`
- Messages from the bot's own user ID are filtered out — check `logs/nanoclaw.log` for the authenticated user ID

### Rate limit errors (429)
- Reduce the number of active chats/channels being monitored
- The adapter caps message polls to 3 per 5-second cycle; if you have many active conversations, some may experience slight delays
