# Zoho Cliq Setup Guide

Complete step-by-step guide for setting up Zoho Cliq with NanoClaw, including OAuth app creation, bot setup, and channel configuration.

## Part 1: Create OAuth App in Zoho API Console

### Step 1: Access Zoho API Console

1. Navigate to [Zoho API Console](https://api-console.zoho.com/) (use the region matching your org):
   - `.com` for US/global
   - `.in` for India
   - `.eu` for Europe
   - Other regional domains available

2. Sign in with your Zoho account

### Step 2: Create a New Client

1. Click the **Add Client** button in the top right

2. Select **Server-based Applications** from the modal

### Step 3: Configure OAuth Application

Fill in the following fields:

| Field | Value | Notes |
|-------|-------|-------|
| **Client Name** | NanoClaw Cliq | Or any name you prefer |
| **Homepage URL** | `http://localhost` | Can be any placeholder URL |
| **Authorized Redirect URI** | `http://localhost:8484/callback` | **Must be exactly this** for NanoClaw |

### Step 4: Copy Credentials

Click **Create** and the app will be generated.

Copy the following values and save them (you'll need them during setup):

- **Client ID**
- **Client Secret**

**Important**: Store the Client Secret securely. NanoClaw will use it to obtain access tokens.

---

## Part 2: Create a Bot in Zoho Cliq Web UI

### Step 1: Open Zoho Cliq

1. Navigate to your Zoho Cliq workspace: `https://cliq.zoho.com` (or region-specific domain)
2. Sign in with your Zoho account

### Step 2: Create a Channel (if needed)

If you already have a channel, skip to **Step 3**. Otherwise:

1. In the left sidebar, locate the **Channels** section
2. Click the **+** icon next to "Channels"
3. Select **Create a Channel**

4. Enter the channel name (e.g., "nano", "bot-testing")
5. Click **Create**

### Step 3: Create a Bot

1. Click your **profile picture** in the top left corner
2. Select **Bots & Tools** from the dropdown menu
3. Click the **+** icon to create a new bot
4. Select **Create a Bot**

4. Fill in the bot details:
   - **Bot Name**: e.g., "NanoClaw", "Assistant"
   - **Bot Unique Name**: e.g., "nanoclaw", "assistant" (lowercase, no spaces — used later for API calls)
   - **Description**: e.g., "NanoClaw AI Assistant"

5. Click **Create**

### Step 4: Add Bot to Channel

1. Open the channel where you want the bot to operate
2. Click the **channel icon** (info button) in the top right

3. In the channel details panel, look for **Members** or **Settings**
4. Find the option to **Add members** or **Add bot**
5. Search for and select your newly created bot

6. Click **Add** to confirm

---

## Part 3: Collect Required Information

### Collect Bot Unique Name

1. Click your **profile picture** in the top left corner
2. Select **Bots & Tools** from the dropdown menu
3. Click on your bot (e.g., "NanoClaw")
4. The **Bot Unique Name** is displayed (e.g., "nanoclaw")
5. Copy this value

### Collect Channel Endpoint and Chat ID

1. Open the channel where your bot is added
2. Click the **channel icon** (info button) in the top right

3. Look for **Connectors** or **API** section in the panel
4. You should see the **Channel Message Endpoint** URL, similar to:
   ```
   https://cliq.zoho.com/api/v2/channelsbyname/nano/message
   ```

5. Copy the full URL (this is your **Channel Endpoint**)

6. In the same panel, look for **Chat ID** (note: this is different from Channel ID)
7. It will look like: `CT_1424358622861866713_922179757`
8. Copy this value

---

## Part 4: Verify Your Information

Before proceeding with NanoClaw setup, verify you have collected:

- ✅ **Client ID** (from API Console)
- ✅ **Client Secret** (from API Console)
- ✅ **Bot Unique Name** (from Zoho Cliq Bots section)
- ✅ **Channel Endpoint** (from Channel info → Connectors)
- ✅ **Chat ID** (from Channel info)

---

## Part 5: Troubleshooting

### Can't find API Console

- Make sure you're logged into Zoho
- Use the correct regional domain (`.com`, `.in`, `.eu`, etc.)
- If you see a "Region" dropdown, select your organization's region

### Can't find Connectors section

- The **Connectors** section appears in the channel info panel
- Make sure you have admin/owner permissions in the channel
- Try refreshing the page if the section doesn't appear

### Bot not appearing in channel members list

- Ensure the bot has been added (see **Part 2: Step 4**)
- Refresh the channel view
- Check that you selected the correct bot

### API credentials not working during setup

- Verify **Client Secret** is correct (it's only shown once during creation)
- Ensure **Authorized Redirect URI** is exactly `http://localhost:8484/callback`
- Check that the OAuth app is a **Server-based Application** (not Client-based)
- Regenerate credentials if needed from the API Console

---

## Next Steps

Once you've collected all information:

1. Run NanoClaw setup: `/setup` or `pnpm run setup:auto`
2. When prompted for Zoho Cliq, follow the interactive flow
3. Paste the values you collected above when requested
4. NanoClaw will handle the OAuth authorization automatically
5. Check your Zoho Cliq channel for a welcome message from your assistant

For more details, see [`.claude/skills/add-zoho-cliq/SKILL.md`](../.claude/skills/add-zoho-cliq/SKILL.md).
