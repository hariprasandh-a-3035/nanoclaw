/**
 * Zoho Cliq channel — native adapter (no Chat SDK bridge).
 *
 * Connects to Zoho Cliq via REST API v2 with OAuth2. Polling-based inbound:
 * periodically checks for new messages in the explicitly configured chats.
 * Outbound via POST {apiUrl}/api/v2/chats/{CHAT_ID}/message.
 *
 * Env vars (all set by the setup OAuth flow):
 *   ZOHO_CLIQ_CLIENT_ID      — OAuth client ID (from Zoho API Console)
 *   ZOHO_CLIQ_CLIENT_SECRET   — OAuth client secret
 *   ZOHO_CLIQ_REFRESH_TOKEN   — OAuth refresh token (obtained via browser OAuth during setup)
 *   ZOHO_CLIQ_API_URL         — Cliq API base URL (e.g. https://cliq.zoho.in)
 *   ZOHO_CLIQ_ACCOUNTS_URL    — IAM/accounts base URL for token ops (e.g. https://accounts.zoho.in)
 *   ZOHO_CLIQ_CHAT_IDS        — Comma-separated list of chat IDs to poll (required — adapter is silent without it)
 *
 * Platform ID format: `zoho-cliq:<chat_id>`
 *
 * Rate limits (per user per minute):
 *   Messages read: 15 · Messages post: 50
 * The adapter polls at 60 s intervals and caps per-cycle message reads to 3
 * to stay safely under the 15 req/min messages quota.
 *
 * Access token is held in memory only — refreshed on startup and every ~55 min.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, ConversationInfo, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

// ── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const MAX_MESSAGE_POLLS_PER_CYCLE = 3;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

const CHANNEL_TYPE = 'zoho-cliq';

// On-disk cache for the short-lived access token. The refresh token in .env
// can mint access tokens, but Zoho rate-limits the refresh endpoint hard
// (~few calls per minute, per app). Without this cache, every service
// restart calls /oauth/v2/token afresh — and several restarts in a short
// window will trip a 400 "too many requests" lockout that blocks polling
// for ~10 minutes. Persisting the access token (valid ~1 hour) means
// restarts reuse a still-good token instead of burning quota.
const TOKEN_CACHE_PATH = path.join(DATA_DIR, 'cliq-token.json');

// ── Zoho Cliq API types ───────────────────────────────────────────────────

interface ZohoMessage {
  id: string;
  time: number;
  type: string;
  sender: { name: string; id: string };
  content: { text?: string };
  meta?: { message_source?: { type?: string } };
}

// ── Adapter ────────────────────────────────────────────────────────────────

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile([
    'ZOHO_CLIQ_CLIENT_ID',
    'ZOHO_CLIQ_CLIENT_SECRET',
    'ZOHO_CLIQ_REFRESH_TOKEN',
    'ZOHO_CLIQ_CHANNEL_ENDPOINT',
    'ZOHO_CLIQ_BOT_UNIQUE_NAME',
    'ZOHO_CLIQ_API_URL',
    'ZOHO_CLIQ_ACCOUNTS_URL',
    'ZOHO_CLIQ_CHAT_ID',
  ]);
  const clientId = env.ZOHO_CLIQ_CLIENT_ID;
  const clientSecret = env.ZOHO_CLIQ_CLIENT_SECRET;
  const refreshToken = env.ZOHO_CLIQ_REFRESH_TOKEN;
  const channelEndpoint = env.ZOHO_CLIQ_CHANNEL_ENDPOINT;
  const botUniqueName = env.ZOHO_CLIQ_BOT_UNIQUE_NAME;
  // Derive apiBase from channel endpoint if not explicitly set
  const apiBase = env.ZOHO_CLIQ_API_URL ?? (channelEndpoint ? new URL(channelEndpoint).origin : '');
  const accountsBase = env.ZOHO_CLIQ_ACCOUNTS_URL;

  if (
    !clientId ||
    !clientSecret ||
    !refreshToken ||
    !channelEndpoint ||
    !botUniqueName ||
    (!apiBase && !channelEndpoint) ||
    !accountsBase
  )
    return null;

  // Single chat ID configured during setup.
  const configuredChatIds = (env.ZOHO_CLIQ_CHAT_ID || env.ZOHO_CLIQ_CHAT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  let accessToken = '';
  let tokenExpiresAt = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let setupConfig: ChannelSetup;
  let connected = false;
  let currentUserId = '';

  // Track last-seen message time per chat to skip already-processed messages.
  const lastSeenTime = new Map<string, number>();

  // ── Token management ─────────────────────────────────────────────────

  async function ensureToken(): Promise<string> {
    // Hot path: in-memory token still good
    if (accessToken && Date.now() < tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      log.info('Zoho Cliq token: served from memory', {
        expiresIn: Math.round((tokenExpiresAt - Date.now()) / 1000) + 's',
      });
      return accessToken;
    }

    // Cold path: try the disk cache before hitting Zoho's refresh endpoint.
    // Missing file, empty file, malformed JSON, or expired contents all
    // fall through silently to a fresh refresh call below — so the file
    // self-heals on first successful refresh after any of those cases.
    if (!accessToken) {
      let raw: string | null = null;
      try {
        raw = fs.readFileSync(TOKEN_CACHE_PATH, 'utf-8');
      } catch {
        log.info('Zoho Cliq token: disk cache missing or unreadable', { path: TOKEN_CACHE_PATH });
      }

      if (raw !== null) {
        let cached: { accessToken?: string; expiresAt?: number } | null = null;
        try {
          cached = JSON.parse(raw) as { accessToken?: string; expiresAt?: number };
        } catch {
          log.warn('Zoho Cliq token: disk cache unparseable, falling through to refresh', { path: TOKEN_CACHE_PATH });
        }

        if (cached) {
          if (
            cached.accessToken &&
            typeof cached.expiresAt === 'number' &&
            Date.now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS
          ) {
            accessToken = cached.accessToken;
            tokenExpiresAt = cached.expiresAt;
            log.info('Zoho Cliq token: loaded from disk cache', {
              path: TOKEN_CACHE_PATH,
              expiresIn: Math.round((tokenExpiresAt - Date.now()) / 1000) + 's',
            });
            return accessToken;
          }
          log.info('Zoho Cliq token: disk cache stale, refreshing', {
            path: TOKEN_CACHE_PATH,
            hasAccessToken: !!cached.accessToken,
            expiresAt: cached.expiresAt ?? null,
            now: Date.now(),
          });
        }
      }
    }

    // Truly need a fresh token: call Zoho's OAuth refresh endpoint.
    log.info('Zoho Cliq token: requesting refresh from Zoho', { accountsBase });
    const url = `${accountsBase}/oauth/v2/token`;
    const body = new URLSearchParams({
      refresh_token: refreshToken!,
      grant_type: 'refresh_token',
      client_id: clientId!,
      client_secret: clientSecret!,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      // Capture every response header — we want to see if Zoho gives us
      // a retry hint (Retry-After, X-RateLimit-Reset, X-RateLimit-Remaining,
      // or any vendor-specific header) when we get rate-limited.
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      log.error('Zoho Cliq token: refresh request failed', {
        status: res.status,
        statusText: res.statusText,
        body: text,
        headers,
        url,
      });
      throw new Error(`Zoho token refresh failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    accessToken = data.access_token;
    // Zoho's expires_in follows the OAuth 2.0 spec: SECONDS, not ms.
    // (Typical value: 3600 = 1 hour.) Treating it as ms — as this code
    // did before — made every refreshed token "expire" 3.6 seconds after
    // it was minted, so the next 5 s poll triggered another refresh,
    // hammering /oauth/v2/token at 12 calls/min and tripping Zoho's
    // rate-limit guard within minutes.
    tokenExpiresAt = Date.now() + data.expires_in * 1000;

    // Persist for next service restart. Best-effort — a write failure must
    // not break the live request path; we'll just refresh again on next
    // restart (back to original behaviour).
    try {
      fs.mkdirSync(path.dirname(TOKEN_CACHE_PATH), { recursive: true });
      fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify({ accessToken, expiresAt: tokenExpiresAt }), { mode: 0o600 });
      log.info('Zoho Cliq token: refreshed and persisted', {
        path: TOKEN_CACHE_PATH,
        expiresIn: Math.round((tokenExpiresAt - Date.now()) / 1000) + 's',
      });
    } catch (err) {
      log.warn('Zoho Cliq: failed to persist access token cache', { err });
    }

    return accessToken;
  }

  // ── API helper ───────────────────────────────────────────────────────

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await ensureToken();
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(`${apiBase}/api/v2${path}`, opts);

    // Auto-refresh on 401 and retry once
    if (res.status === 401) {
      accessToken = '';
      // Drop the disk cache too — a 401 means the cached token is dead
      // (revoked, expired, or otherwise rejected) and reusing it on next
      // restart would just re-trigger this same 401 cycle.
      try {
        fs.unlinkSync(TOKEN_CACHE_PATH);
      } catch {
        /* ignore */
      }
      const newToken = await ensureToken();
      (opts.headers as Record<string, string>).Authorization = `Zoho-oauthtoken ${newToken}`;
      const retry = await fetch(`${apiBase}/api/v2${path}`, opts);
      if (!retry.ok) {
        const text = await retry.text();
        throw new Error(`Zoho Cliq API ${method} ${path} failed (${retry.status}): ${text}`);
      }
      if (retry.status === 204) return {} as T;
      return (await retry.json()) as T;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zoho Cliq API ${method} ${path} failed (${res.status}): ${text}`);
    }
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }

  // ── Poll loop ────────────────────────────────────────────────────────

  async function poll(): Promise<void> {
    if (configuredChatIds.length === 0) return; // strict: no chat IDs = no polling

    try {
      let messagePollCount = 0;

      for (const chatId of configuredChatIds) {
        if (messagePollCount >= MAX_MESSAGE_POLLS_PER_CYCLE) break;
        await pollMessages(chatId, chatId, false);
        messagePollCount++;
      }
    } catch (err) {
      log.error('Zoho Cliq poll error', { err });
    }
  }

  async function pollMessages(chatId: string, chatName: string, isDm: boolean): Promise<void> {
    try {
      const lastTime = lastSeenTime.get(chatId) ?? 0;
      const params = lastTime ? `?fromtime=${lastTime + 1}&limit=20` : '?limit=1';

      log.info('Zoho Cliq poll: starting', {
        chatId,
        params,
        lastSeenTime: lastTime,
        lastSeenTimeISO: lastTime ? new Date(lastTime).toISOString() : null,
      });

      const res = await api<{ data?: ZohoMessage[] }>('GET', `/chats/${chatId}/messages${params}`);
      const messages = res.data ?? [];

      // Diagnostic: log every poll so we can verify what Zoho returns vs.
      // what gets routed to inbound.db. Includes the request URL, count, and
      // a one-line summary of each message (id, time, sender, type, source,
      // first 60 chars of text). Remove or downgrade to debug once the
      // adapter is known healthy.
      log.info('Zoho Cliq poll: response received', {
        chatId,
        params,
        lastSeenTime: lastTime,
        count: messages.length,
        messages: messages.map((m) => ({
          id: m.id,
          time: m.time,
          timeISO: new Date(m.time).toISOString(),
          type: m.type,
          source: m.meta?.message_source?.type ?? null,
          senderId: m.sender?.id,
          senderName: m.sender?.name,
          textPreview: m.content?.text?.slice(0, 60) ?? null,
        })),
      });

      // Report metadata to the router so it can auto-create messaging groups.
      setupConfig.onMetadata(`${CHANNEL_TYPE}:${chatId}`, chatName, !isDm);

      for (const msg of messages) {
        // Skip messages sent by a bot (including our own outbound replies).
        if (msg.meta?.message_source?.type === 'bot') continue;
        // Only process text messages (skip system/info/file messages for now)
        if (msg.type !== 'text' || !msg.content.text) continue;

        // Advance high-water mark
        if (msg.time > (lastSeenTime.get(chatId) ?? 0)) {
          lastSeenTime.set(chatId, msg.time);
        }

        const inbound: InboundMessage = {
          id: msg.id,
          kind: 'chat',
          content: {
            text: msg.content.text,
            sender: msg.sender.name,
            senderId: `${CHANNEL_TYPE}:${msg.sender.id}`,
          },
          timestamp: new Date(msg.time).toISOString(),
          isMention: isDm,
        };

        await setupConfig.onInbound(`${CHANNEL_TYPE}:${chatId}`, null, inbound);
      }
    } catch (err) {
      log.warn('Zoho Cliq message poll error', { chatId, err });
    }
  }

  // ── ChannelAdapter implementation ────────────────────────────────────

  const adapter: ChannelAdapter = {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;

      // Best-effort initial token fetch + user identification. If Zoho is
      // rate-limiting OAuth refreshes (or the network is down) at startup,
      // we MUST NOT block adapter registration on it — otherwise the entire
      // adapter is dropped and no poll timer ever runs, requiring a manual
      // service restart once Zoho recovers. Polling itself handles
      // ensureToken errors gracefully (warns + retries every 5s), so the
      // adapter will recover on its own once Zoho is reachable again.
      try {
        await ensureToken();
        const me = await api<{ id?: string; data?: { id?: string } }>('GET', '/me?source=remote_tools');
        currentUserId = me.data?.id ?? me.id ?? '';
        log.info('Zoho Cliq adapter authenticated', { userId: currentUserId });
      } catch (err) {
        log.warn('Zoho Cliq: initial auth failed — starting poll loop anyway, will retry on each tick', { err });
      }

      if (configuredChatIds.length === 0) {
        log.warn('Zoho Cliq: ZOHO_CLIQ_CHAT_IDS is empty — adapter will not poll any chats');
      }

      pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
      connected = true;
      log.info('Zoho Cliq adapter started', { apiBase, accountsBase, chatIds: configuredChatIds });
    },

    async teardown(): Promise<void> {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      connected = false;
      log.info('Zoho Cliq adapter stopped');
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const chatId = platformId.replace(/^zohocliq:/, '').replace(/^zoho-cliq:/, '');
      const content = message.content as Record<string, unknown>;
      const botParam = `bot_unique_name=${encodeURIComponent(botUniqueName)}`;

      // Edit
      if (content.operation === 'edit' && content.messageId) {
        try {
          await api('PUT', `/chats/${chatId}/messages/${content.messageId}?${botParam}`, {
            text: (content.text as string) || (content.markdown as string) || '',
          });
        } catch (err) {
          log.warn('Zoho Cliq edit failed', { chatId, err });
        }
        return;
      }

      // Reaction
      if (content.operation === 'reaction' && content.messageId && content.emoji) {
        try {
          await api('POST', `/chats/${chatId}/messages/${content.messageId}/reactions?${botParam}`, {
            emoji_code: content.emoji as string,
          });
        } catch (err) {
          log.warn('Zoho Cliq reaction failed', { chatId, err });
        }
        return;
      }

      // Normal text message
      const text = (content.markdown as string) || (content.text as string);
      if (text) {
        try {
          // Always send via bot endpoint so messages are posted by the bot identity.
          const token = await ensureToken();
          const sendUrl = `${channelEndpoint}?bot_unique_name=${encodeURIComponent(botUniqueName)}`;
          const res = await fetch(sendUrl, {
            method: 'POST',
            headers: {
              Authorization: `Zoho-oauthtoken ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text }),
          });
          if (!res.ok) {
            const body = await res.text();
            throw new Error(`Zoho Cliq bot send failed (${res.status}): ${body}`);
          }
          const data = (await res.json()) as { message_id?: string };
          return data.message_id;
        } catch (err) {
          log.error('Zoho Cliq deliver failed', { chatId, err });
        }
      }

      // File attachments
      if (message.files && message.files.length > 0) {
        for (const file of message.files) {
          try {
            const formData = new FormData();
            formData.append('file', new Blob([file.data]), file.filename);

            const token = await ensureToken();
            const res = await fetch(`${apiBase}/api/v2/chats/${chatId}/files`, {
              method: 'POST',
              headers: { Authorization: `Zoho-oauthtoken ${token}` },
              body: formData,
            });
            if (!res.ok) {
              log.warn('Zoho Cliq file upload failed', { chatId, status: res.status });
            }
          } catch (err) {
            log.warn('Zoho Cliq file upload error', { chatId, err });
          }
        }
      }

      return undefined;
    },

    async syncConversations(): Promise<ConversationInfo[]> {
      return configuredChatIds.map((chatId) => ({
        platformId: `${CHANNEL_TYPE}:${chatId}`,
        name: chatId,
        isGroup: false,
      }));
    },
  };

  return adapter;
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
