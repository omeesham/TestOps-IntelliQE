import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('../db.js', () => ({ default: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('../utils/jwt.js', () => ({ verifyToken: vi.fn() }));

import { authMiddleware, revokeUserFromCache } from './auth.middleware';
import { verifyToken } from '../utils/jwt.js';

function res() {
  const r: any = {};
  r.status = vi.fn(() => r);
  r.json = vi.fn(() => r);
  return r;
}
const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as any;
const claimsFor = (uid: string) => ({ sub: 'user', uid, role: 'admin', tid: 't1', tn: 'Acme', pf: false });

beforeEach(() => { query.mockReset(); (verifyToken as any).mockReset(); });

describe('authMiddleware — session revocation (JWT path)', () => {
  it('allows a token whose user is still active', async () => {
    (verifyToken as any).mockReturnValue(claimsFor('U-active'));
    query.mockResolvedValue({ rows: [{ ok: 1 }] });
    const r = res(); const next = vi.fn();
    await authMiddleware(req('jwt.a.b'), r, next);
    expect(next).toHaveBeenCalledOnce();
    expect(r.status).not.toHaveBeenCalled();
  });

  it('rejects a token whose user was deactivated/deleted', async () => {
    (verifyToken as any).mockReturnValue(claimsFor('U-gone'));
    query.mockResolvedValue({ rows: [] }); // no active row
    const r = res(); const next = vi.fn();
    await authMiddleware(req('jwt.a.b'), r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.json).toHaveBeenCalledWith({ error: expect.stringMatching(/revoked/i) });
  });

  it('caches the active check (no DB hit on every request)', async () => {
    (verifyToken as any).mockReturnValue(claimsFor('U-cache'));
    query.mockResolvedValue({ rows: [{ ok: 1 }] });
    await authMiddleware(req('t'), res(), vi.fn());
    await authMiddleware(req('t'), res(), vi.fn());
    expect(query).toHaveBeenCalledTimes(1); // second served from cache
  });

  it('revokeUserFromCache forces a fresh check (immediate revocation)', async () => {
    (verifyToken as any).mockReturnValue(claimsFor('U-bust'));
    query.mockResolvedValue({ rows: [{ ok: 1 }] });
    await authMiddleware(req('t'), res(), vi.fn());
    revokeUserFromCache('U-bust');
    query.mockResolvedValue({ rows: [] }); // now deactivated
    const r = res(); const next = vi.fn();
    await authMiddleware(req('t'), r, next);
    expect(query).toHaveBeenCalledTimes(2);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails OPEN on a transient DB error (does not lock everyone out)', async () => {
    (verifyToken as any).mockReturnValue(claimsFor('U-dberr'));
    query.mockRejectedValue(new Error('db unavailable'));
    const r = res(); const next = vi.fn();
    await authMiddleware(req('t'), r, next);
    expect(next).toHaveBeenCalledOnce();
    expect(r.status).not.toHaveBeenCalled();
  });

  it('rejects an invalid/expired token before any active check', async () => {
    (verifyToken as any).mockImplementation(() => { throw new Error('bad sig'); });
    const r = res(); const next = vi.fn();
    await authMiddleware(req('jwt.bad'), r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(query).not.toHaveBeenCalled();
  });
});
