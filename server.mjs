/**
 * XMTP Proxy Server
 * Runs on Mac mini, handles all XMTP operations.
 * Vercel API routes proxy to this server.
 */

import express from 'express';
import cors from 'cors';
import { Client } from '@xmtp/node-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { toBytes } from 'viem';

const PORT = process.env.XMTP_PROXY_PORT || 3847;
const API_SECRET = process.env.XMTP_PROXY_SECRET || 'changeme';
const ADMIN_KEY = process.env.XMTP_ADMIN_PRIVATE_KEY;

if (!ADMIN_KEY) {
  console.error('XMTP_ADMIN_PRIVATE_KEY required');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// Auth middleware — Vercel routes must send this secret
function authMiddleware(req, res, next) {
  const secret = req.headers['x-proxy-secret'];
  if (secret !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
app.use(authMiddleware);

// --- XMTP Client ---
let adminClient = null;
const account = privateKeyToAccount(ADMIN_KEY);

function getAdminSigner() {
  return {
    type: 'EOA',
    getIdentifier: () => ({
      identifier: account.address.toLowerCase(),
      identifierKind: 0,
    }),
    signMessage: async (message) => {
      const signature = await account.signMessage({ message });
      return toBytes(signature);
    },
  };
}

async function getClient() {
  if (adminClient) return adminClient;
  console.log('[XMTP] Initializing admin client...');
  adminClient = await Client.create(getAdminSigner(), {
    env: 'production',
    appVersion: 'claws/1.0.0',
  });
  console.log('[XMTP] Admin client ready');
  return adminClient;
}

function ethId(address) {
  return { identifier: address.toLowerCase(), identifierKind: 0 };
}

// --- Groups cache (handle -> groupId) ---
const groupCache = new Map();

// --- Routes ---

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Check if address can receive XMTP
app.post('/can-message', async (req, res) => {
  try {
    const { address } = req.body;
    const canMessage = await Client.canMessage([ethId(address)]);
    const reachable = canMessage.get(address.toLowerCase()) ?? false;
    res.json({ reachable });
  } catch (err) {
    console.error('[can-message]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create or get group
app.post('/group', async (req, res) => {
  try {
    const { handle, name, description } = req.body;
    const handleLower = handle.toLowerCase();

    // Check cache
    if (groupCache.has(handleLower)) {
      return res.json({ groupId: groupCache.get(handleLower) });
    }

    const client = await getClient();

    // Try to find existing group by listing conversations
    // For now just create — caller should track groupId in DB
    const group = await client.conversations.createGroup([], {
      groupName: name || `🦞 @${handle} holders`,
      groupDescription: description || `Token-gated chat for @${handle} claw holders on claws.tech`,
    });

    groupCache.set(handleLower, group.id);
    console.log(`[XMTP] Created group for @${handle}: ${group.id}`);
    res.json({ groupId: group.id });
  } catch (err) {
    console.error('[group]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Add member to group
app.post('/add-member', async (req, res) => {
  try {
    const { groupId, address } = req.body;
    const client = await getClient();

    // Check reachability
    const canMessage = await Client.canMessage([ethId(address)]);
    if (!canMessage.get(address.toLowerCase())) {
      return res.json({ added: false, reason: 'not-on-xmtp' });
    }

    const convo = await client.conversations.getConversationById(groupId);
    if (!convo) return res.status(404).json({ error: 'Group not found' });

    await convo.addMembers([ethId(address)]);
    res.json({ added: true });
  } catch (err) {
    console.error('[add-member]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Remove member
app.post('/remove-member', async (req, res) => {
  try {
    const { groupId, address } = req.body;
    const client = await getClient();
    const convo = await client.conversations.getConversationById(groupId);
    if (!convo) return res.status(404).json({ error: 'Group not found' });

    await convo.removeMembers([ethId(address)]);
    res.json({ removed: true });
  } catch (err) {
    console.error('[remove-member]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Check membership
app.post('/is-member', async (req, res) => {
  try {
    const { groupId, address } = req.body;
    const client = await getClient();
    const convo = await client.conversations.getConversationById(groupId);
    if (!convo) return res.json({ isMember: false });

    await convo.sync();
    const members = await convo.listMembers();
    const isMember = members.some(m => {
      const ids = m.accountIdentifiers || [];
      return ids.some(id => id.identifier?.toLowerCase() === address.toLowerCase());
    });
    res.json({ isMember });
  } catch (err) {
    console.error('[is-member]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send message
app.post('/send', async (req, res) => {
  try {
    const { groupId, senderAddress, content } = req.body;
    const client = await getClient();
    const convo = await client.conversations.getConversationById(groupId);
    if (!convo) return res.status(404).json({ error: 'Group not found' });

    // Prefix with sender address so recipients know who sent it
    const formatted = `${senderAddress.slice(0, 6)}...${senderAddress.slice(-4)}: ${content}`;
    const messageId = await convo.sendText(formatted);

    console.log(`[XMTP] Message sent in group ${groupId}: ${messageId}`);
    res.json({ messageId, success: true });
  } catch (err) {
    console.error('[send]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get messages
app.post('/messages', async (req, res) => {
  try {
    const { groupId, limit = 50 } = req.body;
    const client = await getClient();
    const convo = await client.conversations.getConversationById(groupId);
    if (!convo) return res.status(404).json({ error: 'Group not found' });

    await convo.sync();
    const messages = await convo.messages({ limit });

    const filtered = messages
      .filter(m => String(m.kind) === '0' || String(m.kind) === 'application' || String(m.kind) === 'Application')
      .map(m => ({
        id: m.id,
        senderInboxId: m.senderInboxId,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        sentAt: m.sentAt?.toISOString() || new Date().toISOString(),
      }));

    res.json({ messages: filtered });
  } catch (err) {
    console.error('[messages]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Start ---
// Pre-initialize client on startup
getClient().then(() => {
  app.listen(PORT, () => {
    console.log(`[XMTP Proxy] Running on port ${PORT}`);
  });
}).catch(err => {
  console.error('[XMTP Proxy] Failed to initialize:', err);
  process.exit(1);
});
