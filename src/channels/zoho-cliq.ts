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

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  ConversationInfo,
  InboundMessage,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

// ── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000;
const MAX_MESSAGE_POLLS_PER_CYCLE = 3;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

const CHANNEL_TYPE = 'zoho-cliq';

// ── Zoho Cliq API types ───────────────────────────────────────────────────

interface ZohoMessage {
  id: string;
  time: number;
  type: string;
  sender: { name: string; id: string };
  content: { text?: string };
}

// ── Adapter ────────────────────────────────────────────────────────────────

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile([
    'ZOHO_CLIQ_CLIENT_ID',
    'ZOHO_CLIQ_CLIENT_SECRET',
    'ZOHO_CLIQ_REFRESH_TOKEN',
    'ZOHO_CLIQ_API_URL',
    'ZOHO_CLIQ_ACCOUNTS_URL',
    'ZOHO_CLIQ_CHAT_IDS',
  ]);
  const clientId = env.ZOHO_CLIQ_CLIENT_ID;
  const clientSecret = env.ZOHO_CLIQ_CLIENT_SECRET;
  const refreshToken = env.ZOHO_CLIQ_REFRESH_TOKEN;
  const apiBase = env.ZOHO_CLIQ_API_URL;
  const accountsBase = env.ZOHO_CLIQ_ACCOUNTS_URL;

  if (!clientId || !clientSecret || !refreshToken || !apiBase || !accountsBase) return null;

  // Parse the explicit list of chat IDs to poll. Adapter is silent without it.
  const configuredChatIds = (env.ZOHO_CLIQ_CHAT_IDS || '')
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
    if (accessToken && Date.now() < tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return accessToken;
    }
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
      throw new Error(`Zoho token refresh failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    accessToken = data.access_token;
    // expires_in is in ms for Zoho OAuth
    tokenExpiresAt = Date.now() + data.expires_in;
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
      const res = await api<{ data?: ZohoMessage[] }>('GET', `/chats/${chatId}/messages${params}`);
      const messages = res.data ?? [];

      // Report metadata to the router so it can auto-create messaging groups.
      setupConfig.onMetadata(`${CHANNEL_TYPE}:${chatId}`, chatName, !isDm);

      for (const msg of messages) {
        // Skip bot's own messages
        if (msg.sender.id === currentUserId) continue;
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

      // Get initial access token
      await ensureToken();

      // Identify the authenticated user so we can filter out our own messages.
      try {
        const me = await api<{ id?: string; data?: { id?: string } }>('GET', '/me?source=remote_tools');
        currentUserId = me.data?.id ?? me.id ?? '';
        log.info('Zoho Cliq adapter authenticated', { userId: currentUserId });
      } catch (err) {
        log.warn('Zoho Cliq: could not fetch current user — own-message filtering may not work', { err });
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

      // Edit
      if (content.operation === 'edit' && content.messageId) {
        try {
          await api('PUT', `/chats/${chatId}/messages/${content.messageId}`, {
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
          await api('POST', `/chats/${chatId}/messages/${content.messageId}/reactions`, {
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
          const res = await api<{ message_id?: string }>('POST', `/chats/${chatId}/message`, {
            text,
            sync_message: true,
          });
          return res.message_id;
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
