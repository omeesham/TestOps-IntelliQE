import pool from '../db.js';

export interface CreateConversationParams {
  tenantId: string;
  username: string;
  title?: string;
}

export interface SaveMessageParams {
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, unknown>;
}

export async function createConversation(params: CreateConversationParams) {
  const { rows } = await pool.query(
    `INSERT INTO conversations (username, title, tenant_id) VALUES ($1, $2, $3) RETURNING id, created_at`,
    [params.username, params.title || null, params.tenantId]
  );
  return { id: rows[0].id, createdAt: rows[0].created_at };
}

export async function saveMessage(params: SaveMessageParams) {
  const { rows } = await pool.query(
    `INSERT INTO messages (conversation_id, role, content, metadata)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [params.conversationId, params.role, params.content, params.metadata ? JSON.stringify(params.metadata) : null]
  );
  // Update the conversation's updated_at timestamp
  await pool.query(
    `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
    [params.conversationId]
  );
  return { id: rows[0].id, createdAt: rows[0].created_at };
}

/**
 * Get conversations for a tenant.
 * If isPlatform=true, returns ALL conversations across tenants.
 */
export async function getConversationsByTenant(tenantId: string, isPlatform: boolean) {
  if (isPlatform) {
    const { rows } = await pool.query(
      `SELECT id, username, title, tenant_id, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC
       LIMIT 50`
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, username, title, tenant_id, created_at, updated_at
     FROM conversations
     WHERE tenant_id = $1
     ORDER BY updated_at DESC
     LIMIT 50`,
    [tenantId]
  );
  return rows;
}

/**
 * Return the conversation row iff it belongs to the given tenant (platform
 * tenants may access any). Used to authorize per-conversation reads/writes so
 * one tenant can't reach another tenant's messages by guessing an id.
 */
export async function getConversationForTenant(
  conversationId: string,
  tenantId: string,
  isPlatform: boolean,
) {
  const filter = isPlatform ? '' : ' AND tenant_id = $2';
  const params: any[] = [conversationId];
  if (!isPlatform) params.push(tenantId);
  const { rows } = await pool.query(
    `SELECT id, tenant_id FROM conversations WHERE id = $1${filter}`,
    params,
  );
  return rows[0] || null;
}

export async function getMessagesByConversation(conversationId: string) {
  const { rows } = await pool.query(
    `SELECT id, role, content, metadata, created_at
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId]
  );
  return rows;
}
