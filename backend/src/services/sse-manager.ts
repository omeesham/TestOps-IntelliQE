/**
 * SSE Connection Manager — manages Server-Sent Event connections per pipeline run.
 */

import type { Response } from 'express';
import type { SSEEvent } from '../orchestrator/types.js';

interface SSEConnection {
  res: Response;
  role: 'user' | 'admin';
}

const connections = new Map<string, SSEConnection[]>();

export function registerSSEConnection(runId: string, res: Response, role: 'user' | 'admin' = 'user'): void {
  if (!connections.has(runId)) connections.set(runId, []);
  connections.get(runId)!.push({ res, role });

  res.on('close', () => {
    const conns = connections.get(runId);
    if (conns) {
      const idx = conns.findIndex(c => c.res === res);
      if (idx !== -1) conns.splice(idx, 1);
      if (conns.length === 0) connections.delete(runId);
    }
  });
}

export function broadcastSSE(runId: string, event: SSEEvent): void {
  const conns = connections.get(runId);
  if (!conns) return;

  const visibility = (event as any).visibility || 'public';
  const data = JSON.stringify(event);

  for (const conn of conns) {
    if (visibility === 'admin' && conn.role !== 'admin') continue;
    try {
      conn.res.write(`data: ${data}\n\n`);
    } catch {
      // Connection closed
    }
  }

  // On the terminal event, close the streams and release the run's connections
  // so they don't linger open waiting for the client to disconnect.
  if ((event as any).type === 'pipeline_complete') {
    for (const conn of conns) {
      try { conn.res.end(); } catch { /* already closed */ }
    }
    connections.delete(runId);
  }
}

export function broadcastToAll(event: SSEEvent): void {
  const data = JSON.stringify(event);
  for (const [, conns] of connections) {
    for (const conn of conns) {
      try { conn.res.write(`data: ${data}\n\n`); } catch {}
    }
  }
}
