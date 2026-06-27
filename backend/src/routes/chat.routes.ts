import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  createConversation,
  saveMessage,
  getConversationsByTenant,
  getMessagesByConversation,
  getConversationOwner,
} from '../services/chat.service.js';
import { sanitizeChatContent } from '../utils/crypto.js';

const router = Router();

/** Confirm the conversation exists and belongs to the caller's tenant.
 *  Responds 404 and returns false otherwise (doesn't leak existence). */
async function canAccessConversation(req: Request, res: Response, conversationId: string): Promise<boolean> {
  const user = req.user!;
  const owner = await getConversationOwner(conversationId);
  if (!owner || (!user.isPlatform && owner.tenant_id !== user.tenantId)) {
    res.status(404).json({ error: 'Conversation not found' });
    return false;
  }
  return true;
}

// POST /api/chat/conversations — Create a new conversation
router.post('/conversations', async (req: Request, res: Response) => {
  try {
    const { title } = req.body;
    const user = req.user!;
    const conversation = await createConversation({
      tenantId: user.tenantId,
      username: user.username,
      title,
    });
    res.json(conversation);
  } catch (err) {
    console.error('Error creating conversation:', err);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// POST /api/chat/messages — Save a message
// ⛔ Sanitizes content to strip any credential patterns before persisting.
router.post('/messages', async (req: Request, res: Response) => {
  try {
    const { conversationId, role, content, metadata } = req.body;
    if (!conversationId || !role || !content) {
      res.status(400).json({ error: 'conversationId, role, and content are required' });
      return;
    }
    if (!(await canAccessConversation(req, res, conversationId))) return;
    // Strip any credentials/tokens/keys from message content
    const sanitizedContent = sanitizeChatContent(content);
    const message = await saveMessage({ conversationId, role, content: sanitizedContent, metadata });
    res.json(message);
  } catch (err) {
    console.error('Error saving message:', err);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// GET /api/chat/conversations — List conversations for the tenant
router.get('/conversations', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const conversations = await getConversationsByTenant(user.tenantId, user.isPlatform);
    res.json(conversations);
  } catch (err) {
    console.error('Error fetching conversations:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// GET /api/chat/conversations/:id/messages — Get messages for a conversation
router.get('/conversations/:id/messages', async (req: Request, res: Response) => {
  try {
    if (!(await canAccessConversation(req, res, req.params.id as string))) return;
    const messages = await getMessagesByConversation(req.params.id as string);
    res.json(messages);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

export default router;
