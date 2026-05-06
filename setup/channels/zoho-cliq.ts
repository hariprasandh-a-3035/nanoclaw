/**
 * Zoho Cliq channel flow for setup:auto.
 *
 * `runZohoCliqChannel(displayName)` owns the full branch from the
 * Zoho API Console instructions through the welcome DM:
 *
 *   1. Zoho API Console instructions (clack note)
 *   2. Paste the Client ID and Client Secret
 *   3. Paste the Cliq API URL (e.g. https://cliq.zoho.in)
 *   4. Paste the chat IDs to poll
 *   5. Browser OAuth flow: spin up localhost:8484, open browser for consent,
 *      receive callback with authorization code, exchange for refresh token
 *   6. Install the adapter (setup/add-zoho-cliq.sh, non-interactive)
 *   7. Ask for the messaging-agent name (defaulting to "Nano")
 *   8. Wire the agent via scripts/init-first-agent.ts
 *
 * All output obeys the three-level contract: clack UI for the user,
 * structured entries in logs/setup.log, full raw output in per-step files
 * under logs/setup-steps/. See docs/setup-flow.md.
 */
import http from 'http';
import { exec } from 'child_process';
import * as p from '@clack/prompts';
import k from 'kleur';

import { readEnvFile } from '../../src/env.js';
import * as setupLog from '../logs.js';
import {
  type StepResult,
  ensureAnswer,
  fail,
  runQuietChild,
  writeStepEntry,
} from '../lib/runner.js';

const DEFAULT_AGENT_NAME = 'Nano';
const OAUTH_CALLBACK_PORT = 8484;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;
const OAUTH_SCOPES =
  'ZohoCliq.Webhooks.CREATE,ZohoCliq.Messages.ALL,ZohoCliq.Chats.READ,ZohoCliq.Channels.READ,ZohoCliq.Profile.READ';

/**
 * Derive the Zoho Accounts (IAM) base URL from the Cliq API URL.
 * e.g. https://cliq.zoho.in → https://accounts.zoho.in
 */
function deriveAccountsUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  const accountsHost = url.hostname.replace(/^cliq\./, 'accounts.');
  return `${url.protocol}//${accountsHost}`;
}

/** Open a URL in the default browser (cross-platform). */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

export async function runZohoCliqChannel(displayName: string): Promise<void> {
  // Read .env up front. setup/auto.ts and nanoclaw.sh do NOT load .env into
  // process.env (deliberate — keeps secrets out of the env handed to child
  // processes), so process.env.ZOHO_CLIQ_* is always empty here. Every
  // reuse check below has to read from this in-memory map, not process.env.
  const dotenv = readEnvFile([
    'ZOHO_CLIQ_BOT_UNIQUE_NAME',
    'ZOHO_CLIQ_CHANNEL_ENDPOINT',
    'ZOHO_CLIQ_CHAT_ID',
    'ZOHO_CLIQ_CLIENT_ID',
    'ZOHO_CLIQ_CLIENT_SECRET',
    'ZOHO_CLIQ_REFRESH_TOKEN',
  ]);
  // Populate process.env so the inner collect*() helpers (which read
  // process.env.ZOHO_CLIQ_*) see the same view as the top-level reuse check.
  // Scoped to this run only; we don't write back to .env from here.
  for (const [k, v] of Object.entries(dotenv)) {
    if (v && !process.env[k]) process.env[k] = v;
  }

  const allPresent =
    dotenv.ZOHO_CLIQ_BOT_UNIQUE_NAME?.trim() &&
    dotenv.ZOHO_CLIQ_CHANNEL_ENDPOINT?.trim() &&
    dotenv.ZOHO_CLIQ_CHAT_ID?.trim() &&
    dotenv.ZOHO_CLIQ_CLIENT_ID?.trim() &&
    dotenv.ZOHO_CLIQ_CLIENT_SECRET?.trim() &&
    dotenv.ZOHO_CLIQ_REFRESH_TOKEN?.trim();

  // Ask once whether to reuse the entire .env config. Only show this prompt
  // when every required value is already present — otherwise we'd be asking
  // the user to "reuse" a partial config, which would still need prompts
  // for the missing fields and is more confusing than just falling through
  // to the per-field reuse prompts inside collect*().
  //
  // If the user declines, we want a clean reconfigure — NO per-field
  // "use existing?" prompts. The inner collect*() helpers decide whether
  // to offer reuse based on process.env, so we strip the Cliq values out
  // of process.env to suppress those follow-up confirmations.
  let reuseAll = false;
  if (allPresent) {
    reuseAll = ensureAnswer(await p.confirm({
      message: 'Found a complete Zoho Cliq configuration in .env. Reuse it (skip all prompts)?',
      initialValue: true,
    }));
    setupLog.userInput('zoho_cliq_reuse_all', reuseAll ? 'yes' : 'no');
    if (!reuseAll) {
      delete process.env.ZOHO_CLIQ_BOT_UNIQUE_NAME;
      delete process.env.ZOHO_CLIQ_CHANNEL_ENDPOINT;
      delete process.env.ZOHO_CLIQ_CHAT_ID;
      delete process.env.ZOHO_CLIQ_CLIENT_ID;
      delete process.env.ZOHO_CLIQ_CLIENT_SECRET;
      delete process.env.ZOHO_CLIQ_REFRESH_TOKEN;
    }
  }

  let botUniqueName: string;
  let channelEndpoint: string;
  let chatId: string;
  let clientId: string;
  let clientSecret: string;
  let refreshToken: string;

  if (reuseAll) {
    // User confirmed full reuse: pull every value from .env, skip every
    // prompt, skip the browser OAuth flow.
    p.log.info('Using existing Zoho Cliq configuration from .env — skipping prompts.');
    botUniqueName = dotenv.ZOHO_CLIQ_BOT_UNIQUE_NAME!.trim();
    channelEndpoint = dotenv.ZOHO_CLIQ_CHANNEL_ENDPOINT!.trim();
    chatId = dotenv.ZOHO_CLIQ_CHAT_ID!.trim();
    clientId = dotenv.ZOHO_CLIQ_CLIENT_ID!.trim();
    clientSecret = dotenv.ZOHO_CLIQ_CLIENT_SECRET!.trim();
    refreshToken = dotenv.ZOHO_CLIQ_REFRESH_TOKEN!.trim();
  } else {
    botUniqueName = await collectBotUniqueName();
    channelEndpoint = await collectChannelEndpoint();
    chatId = await collectChatId();
    ({ clientId, clientSecret } = await collectClientCredentials());

    const apiUrlForOAuth = new URL(channelEndpoint).origin;
    const accountsUrlForOAuth = deriveAccountsUrl(apiUrlForOAuth);
    p.note(
      [
        `Derived accounts URL: ${k.cyan(accountsUrlForOAuth)}`,
        '',
        k.dim('This is used for OAuth token operations.'),
      ].join('\n'),
      'Zoho Accounts URL',
    );

    // Refresh-token reuse: only offer if the user hasn't already declined a
    // full reconfigure at the top-level prompt. If `allPresent` was true and
    // they said "no" to reuse-all, treat that as "redo everything fresh" —
    // skip the per-field reuse confirmation and go straight to OAuth.
    const existingRefreshToken = dotenv.ZOHO_CLIQ_REFRESH_TOKEN?.trim();
    if (existingRefreshToken && !allPresent) {
      const reuse = ensureAnswer(await p.confirm({
        message: `Found an existing Zoho Cliq refresh token (${existingRefreshToken.slice(0, 8)}…). Use it?`,
        initialValue: true,
      }));
      if (reuse) {
        refreshToken = existingRefreshToken;
        setupLog.userInput('zoho_cliq_refresh_token', 'reused-existing');
      } else {
        refreshToken = await runOAuthFlow(clientId, clientSecret, accountsUrlForOAuth);
      }
    } else {
      refreshToken = await runOAuthFlow(clientId, clientSecret, accountsUrlForOAuth);
    }
  }

  const apiUrl = new URL(channelEndpoint).origin;
  const accountsUrl = deriveAccountsUrl(apiUrl);

  // Fetch the authenticated user's ID for agent wiring.
  const userId = await fetchMyUserId(apiUrl, clientId, clientSecret, refreshToken, accountsUrl);

  // Verify connectivity: post a test message and fetch recent messages.
  await verifyConnection(channelEndpoint, botUniqueName, clientId, clientSecret, refreshToken, accountsUrl, chatId);

  const primaryChatId = chatId;

  const rawLog = setupLog.stepRawLog('add-zoho-cliq');
  const start = Date.now();

  const install = await runQuietChild(
    'zoho-cliq-install',
    'bash',
    ['setup/add-zoho-cliq.sh'],
    {
      running: 'Connecting Zoho Cliq…',
      done: 'Zoho Cliq connected.',
    },
    {
      env: {
        ZOHO_CLIQ_CLIENT_ID: clientId,
        ZOHO_CLIQ_CLIENT_SECRET: clientSecret,
        ZOHO_CLIQ_REFRESH_TOKEN: refreshToken,
        ZOHO_CLIQ_CHANNEL_ENDPOINT: channelEndpoint,
        ZOHO_CLIQ_BOT_UNIQUE_NAME: botUniqueName,
        ZOHO_CLIQ_API_URL: apiUrl,
        ZOHO_CLIQ_ACCOUNTS_URL: accountsUrl,
        ZOHO_CLIQ_CHAT_ID: chatId,
      },
      extraFields: { CHANNEL_ENDPOINT: channelEndpoint, BOT_UNIQUE_NAME: botUniqueName, CHAT_ID: chatId },
    },
  );
  const durationMs = Date.now() - start;
  writeStepEntry('zoho-cliq-install', install, durationMs, rawLog);

  if (!install.ok) {
    await fail(
      'zoho-cliq-install',
      "Couldn't connect Zoho Cliq.",
      'See logs/setup-steps/ for details, then retry setup.',
    );
  }

  const agentName = await resolveAgentName();

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', 'zoho-cliq',
      '--user-id', `zoho-cliq:${userId}`,
      '--platform-id', `zoho-cliq:${primaryChatId}`,
      '--display-name', displayName,
      '--agent-name', agentName,
    ],
    {
      running: `Connecting ${agentName} to Zoho Cliq…`,
      done: `${agentName} is ready. Check Zoho Cliq for a welcome message.`,
    },
    {
      extraFields: { CHANNEL: 'zoho-cliq', AGENT_NAME: agentName },
    },
  );
  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'You can retry later with `/manage-channels`.',
    );
  }
}

// ── Credential collection ──────────────────────────────────────────────────

async function collectClientCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  const existingClientId = process.env.ZOHO_CLIQ_CLIENT_ID?.trim();
  const existingClientSecret = process.env.ZOHO_CLIQ_CLIENT_SECRET?.trim();
  if (existingClientId && existingClientSecret) {
    const reuse = ensureAnswer(await p.confirm({
      message: `Found existing Zoho Cliq OAuth credentials (${existingClientId.slice(0, 8)}…). Use them?`,
      initialValue: true,
    }));
    if (reuse) {
      setupLog.userInput('zoho_cliq_client_id', 'reused-existing');
      setupLog.userInput('zoho_cliq_client_secret', 'reused-existing');
      return { clientId: existingClientId, clientSecret: existingClientSecret };
    }
  }

  p.note(
    [
      'Your assistant connects to Zoho Cliq via a server-based OAuth2 app.',
      "Here's how to set it up:",
      '',
      '  1. Go to https://api.console.zoho.com/',
      '  2. Click "Add Client" → "Server-based Applications"',
      `  3. Set the redirect URI to ${k.cyan(OAUTH_REDIRECT_URI)}`,
      '  4. Copy the Client ID and Client Secret',
      '',
      k.dim('We will open a browser window for OAuth consent in a moment.'),
    ].join('\n'),
    'Set up your Zoho Cliq app',
  );

  const clientId = (ensureAnswer(
    await p.text({
      message: 'Paste your Client ID',
      validate: (v) => {
        if (!v || !v.trim()) return 'Client ID is required';
        return undefined;
      },
    }),
  ) as string).trim();
  setupLog.userInput('zoho_cliq_client_id', `${clientId.slice(0, 8)}…`);

  const clientSecret = (ensureAnswer(
    await p.password({
      message: 'Paste your Client Secret',
      validate: (v) => {
        if (!v || !v.trim()) return 'Client Secret is required';
        return undefined;
      },
    }),
  ) as string).trim();
  setupLog.userInput('zoho_cliq_client_secret', '(redacted)');

  return { clientId, clientSecret };
}

async function collectChannelEndpoint(): Promise<string> {
  const existing = process.env.ZOHO_CLIQ_CHANNEL_ENDPOINT?.trim();
  if (existing) {
    try {
      if (/\/api\/v2\/channelsbyname\/[^/]+\/message$/i.test(new URL(existing).pathname)) {
        const reuse = ensureAnswer(await p.confirm({
          message: `Found an existing channel endpoint (${existing.slice(0, 48)}…). Use it?`,
          initialValue: true,
        }));
        if (reuse) {
          setupLog.userInput('zoho_cliq_channel_endpoint', 'reused-existing');
          return existing;
        }
      }
    } catch {
      // Ignore invalid existing value and fall back to prompting.
    }
  }

  p.note(
    [
      'Get the channel endpoint and chat ID from Zoho Cliq:',
      '',
      '  1. Open the target channel in Zoho Cliq',
      '  2. Click the channel icon',
      '  3. Open Connectors',
      '  4. Copy the channel message endpoint and chat ID',
    ].join('\n'),
    'Channel details',
  );

  const answer = (ensureAnswer(
    await p.text({
      message: 'Paste your Zoho Cliq channel message endpoint',
      placeholder: 'https://cliq.zoho.com/api/v2/channelsbyname/my_channel/message',
      validate: (v) => {
        if (!v || !v.trim()) return 'Channel endpoint is required';
        try {
          const url = new URL(v.trim());
          if (!url.hostname.includes('cliq.')) {
            return 'URL should be a Zoho Cliq API URL (e.g. https://cliq.zoho.com/api/v2/channelsbyname/my_channel/message)';
          }
          if (!url.pathname.includes('/channelsbyname/') || !url.pathname.endsWith('/message')) {
            return 'URL must follow the format: https://cliq.zoho.com/api/v2/channelsbyname/<CHANNEL_NAME>/message';
          }
        } catch {
          return 'Not a valid URL';
        }
        return undefined;
      },
    }),
  ) as string).trim();

  setupLog.userInput('zoho_cliq_channel_endpoint', answer);
  return answer;
}

async function collectBotUniqueName(): Promise<string> {
  const existing = process.env.ZOHO_CLIQ_BOT_UNIQUE_NAME?.trim();
  if (existing) {
    const reuse = ensureAnswer(await p.confirm({
      message: `Found an existing bot unique name (${existing}). Use it?`,
      initialValue: true,
    }));
    if (reuse) {
      setupLog.userInput('zoho_cliq_bot_unique_name', 'reused-existing');
      return existing;
    }
  }

  const answer = (ensureAnswer(
    await p.text({
      message: 'Paste your Zoho Cliq bot unique name',
      placeholder: 'my_bot',
      validate: (v) => {
        if (!v || !v.trim()) return 'Bot unique name is required';
        return undefined;
      },
    }),
  ) as string).trim();

  setupLog.userInput('zoho_cliq_bot_unique_name', answer);
  return answer;
}

async function collectChatId(): Promise<string> {
  const existing = process.env.ZOHO_CLIQ_CHAT_ID?.trim();
  if (existing) {
    const reuse = ensureAnswer(await p.confirm({
      message: `Found an existing chat ID (${existing}). Use it?`,
      initialValue: true,
    }));
    if (reuse) {
      setupLog.userInput('zoho_cliq_chat_id', 'reused-existing');
      return existing;
    }
  }

  p.note(
    [
      'Make sure your bot is added to the channel before continuing.',
      '',
      'Use the same channel icon → Connectors screen to copy the chat ID.',
    ].join('\n'),
    'Add bot to channel',
  );

  const answer = (ensureAnswer(
    await p.text({
      message: 'Paste the chat ID of the channel where the bot is added',
      placeholder: 'CT_1424358622861866713_922179757',
      validate: (v) => {
        if (!v || !v.trim()) return 'Chat ID is required';
        return undefined;
      },
    }),
  ) as string).trim();

  setupLog.userInput('zoho_cliq_chat_id', answer);
  return answer;
}

// ── OAuth browser flow ─────────────────────────────────────────────────────

/**
 * Run the OAuth authorization code flow:
 * 1. Start a local HTTP server on :8484
 * 2. Open the browser to Zoho's consent page
 * 3. Wait for the callback with the authorization code
 * 4. Exchange the code for access_token + refresh_token
 * 5. Return the refresh_token
 */
async function runOAuthFlow(
  clientId: string,
  clientSecret: string,
  accountsUrl: string,
): Promise<string> {
  const s = p.spinner();

  // Build the authorization URL
  const authParams = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  const authUrl = `${accountsUrl}/oauth/v2/auth?${authParams}`;

  // Wait for the authorization code via local callback server
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://localhost:${OAUTH_CALLBACK_PORT}`);
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const authCode = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorization failed</h2><p>You can close this tab.</p>');
        server.close();
        reject(new Error(`OAuth denied: ${error}`));
        return;
      }

      if (!authCode) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>Missing authorization code</h2><p>Try again.</p>');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p>');
      server.close();
      resolve(authCode);
    });

    server.listen(OAUTH_CALLBACK_PORT, () => {
      p.note(
        [
          'Opening your browser for Zoho authorization…',
          '',
          'If the browser doesn\'t open, visit this URL manually:',
          k.dim(authUrl),
        ].join('\n'),
        'OAuth consent',
      );
      openBrowser(authUrl);
      s.start('Waiting for authorization in the browser…');
    });

    server.on('error', (err) => {
      reject(new Error(`Could not start OAuth callback server on port ${OAUTH_CALLBACK_PORT}: ${err.message}`));
    });

    // 5 minute timeout
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth flow timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });

  s.stop('Authorization received.');
  setupLog.step('zoho-cliq-oauth-code', 'success', 0, {});

  // Exchange the authorization code for tokens
  s.start('Exchanging authorization code for tokens…');
  const start = Date.now();

  try {
    const tokenParams = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
    });

    const res = await fetch(`${accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    const elapsedS = Math.round((Date.now() - start) / 1000);

    if (data.refresh_token) {
      s.stop(`Tokens obtained. ${k.dim(`(${elapsedS}s)`)}`);
      setupLog.step('zoho-cliq-oauth-exchange', 'success', Date.now() - start, {});
      return data.refresh_token;
    }

    const reason = data.error ?? 'no refresh_token in response';
    s.stop(`Token exchange failed: ${reason}`, 1);
    setupLog.step('zoho-cliq-oauth-exchange', 'failed', Date.now() - start, { ERROR: reason });
    await fail(
      'zoho-cliq-oauth-exchange',
      'Token exchange failed.',
      `Zoho returned: ${reason}. Retry setup.`,
    );
    throw new Error('unreachable');
  } catch (err) {
    if ((err as Error).message === 'unreachable') throw err;
    const elapsedS = Math.round((Date.now() - start) / 1000);
    s.stop(`Couldn't reach Zoho. ${k.dim(`(${elapsedS}s)`)}`, 1);
    const message = err instanceof Error ? err.message : String(err);
    setupLog.step('zoho-cliq-oauth-exchange', 'failed', Date.now() - start, { ERROR: message });
    await fail(
      'zoho-cliq-oauth-exchange',
      "Couldn't reach Zoho.",
      'Check your internet connection and retry setup.',
    );
    throw new Error('unreachable');
  }
}

// ── Fetch authenticated user ───────────────────────────────────────────────

/**
 * Get a fresh access token and call /api/v2/me to resolve the operator's
 * Zoho Cliq user ID. Used for --user-id in init-first-agent.
 */
async function fetchMyUserId(
  apiUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  accountsUrl: string,
): Promise<string> {
  const s = p.spinner();
  s.start('Resolving your Zoho Cliq user ID…');

  try {
    // Get a fresh access token.
    const tokenParams = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });
    const tokenRes = await fetch(`${accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });
    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      throw new Error(tokenData.error ?? 'token refresh failed');
    }

    // Zoho Cliq uses "Zoho-oauthtoken" not "Bearer".
    // GET /api/v2/me?source=remote_tools returns the authenticated user's profile.
    const meRes = await fetch(`${apiUrl}/api/v2/me?source=remote_tools`, {
      headers: { Authorization: `Zoho-oauthtoken ${tokenData.access_token}` },
    });
    const meData = (await meRes.json()) as { id?: string; zuid?: string; name?: string; email_id?: string };
    const userId = meData.zuid ?? meData.id;
    if (!userId) {
      throw new Error('Could not resolve user ID from /api/v2/me — check OAuth scopes include ZohoCliq.Profile.READ');
    }

    const emailId = meData.email_id;
    const displayInfo = emailId ? `${k.cyan(userId)} (${k.dim(emailId)})` : k.cyan(userId);
    s.stop(`User ID: ${displayInfo}`);
    setupLog.step('zoho-cliq-resolve-user', 'success', 0, { USER_ID: userId, EMAIL: emailId ?? '' });
    return userId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop(`Couldn't resolve user ID: ${message}`, 1);
    setupLog.step('zoho-cliq-resolve-user', 'failed', 0, { ERROR: message });
    await fail(
      'zoho-cliq-resolve-user',
      "Couldn't resolve your Zoho Cliq user ID.",
      'Check your credentials and retry setup.',
    );
    throw new Error('unreachable');
  }
}

// ── Verify connection ──────────────────────────────────────────────────────

/**
 * Post a test message to the chat and fetch recent messages to verify connectivity.
 */
async function verifyConnection(
  channelEndpoint: string,
  botUniqueName: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  accountsUrl: string,
  chatId: string,
): Promise<void> {
  const s = p.spinner();
  s.start('Verifying connection…');

  try {
    // Get a fresh access token.
    const tokenParams = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });
    const tokenRes = await fetch(`${accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });
    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      s.stop(k.dim('Could not verify connection (token refresh failed)'));
      return;
    }
    const headers = { Authorization: `Zoho-oauthtoken ${tokenData.access_token}` };

    // Post a test message via the bot endpoint.
    const sendUrl = `${channelEndpoint}?bot_unique_name=${encodeURIComponent(botUniqueName)}`;
    const postRes = await fetch(sendUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '👋 NanoClaw connected successfully.' }),
    });

    if (!postRes.ok) {
      s.stop(k.dim(`Could not post test message (${postRes.status})`));
      return;
    }

    // Fetch recent messages using the configured chat ID.
    const apiBase = new URL(channelEndpoint).origin;
    const msgRes = await fetch(`${apiBase}/api/v2/chats/${chatId}/messages?limit=5`, { headers });
    if (msgRes.ok) {
      const msgData = (await msgRes.json()) as { data?: Array<{ text?: string; content?: { text?: string }; sender?: { name?: string } }> };
      const messages = msgData.data ?? [];
      if (messages.length > 0) {
        const preview = messages
          .slice(0, 3)
          .map((m) => {
            const text = m.text || m.content?.text || '(no text)';
            const sender = m.sender?.name ?? 'unknown';
            return `  ${k.dim(sender)}: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`;
          })
          .join('\n');
        s.stop('Connection verified ✓');
        p.log.info(`Recent messages:\n${preview}`);
      } else {
        s.stop('Connection verified ✓ (no recent messages)');
      }
    } else {
      s.stop('Test message sent ✓ (could not fetch recent messages)');
    }
  } catch {
    s.stop(k.dim('Could not verify connection'));
  }
}

// ── Agent name ─────────────────────────────────────────────────────────────

async function resolveAgentName(): Promise<string> {
  const preset = process.env.NANOCLAW_AGENT_NAME?.trim();
  if (preset) {
    setupLog.userInput('agent_name', preset);
    return preset;
  }
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your assistant be called?',
      placeholder: DEFAULT_AGENT_NAME,
      defaultValue: DEFAULT_AGENT_NAME,
    }),
  );
  const value = (answer as string).trim() || DEFAULT_AGENT_NAME;
  setupLog.userInput('agent_name', value);
  return value;
}