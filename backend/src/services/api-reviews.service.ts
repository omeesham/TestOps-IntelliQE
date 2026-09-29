/**
 * api-reviews.service.ts
 * ──────────────────────
 * Run sign-off — a lightweight review thread on an API run. A teammate can
 * approve, reject, mark needs-work, or leave a comment, each with a note. The
 * run's current sign-off is the most recent decision that isn't a plain
 * comment.
 *
 * It uses the existing tenant + user context and grants no permissions — it is
 * a collaboration record layered beside the run, touching nothing in the
 * pipeline or auth. (Full role-based access control is a separate concern that
 * would change the auth layer, so it is deliberately not attempted here.)
 */
import pool from '../db.js';

export type ReviewDecision = 'approved' | 'rejected' | 'needs_work' | 'comment';
const DECISIONS: ReviewDecision[] = ['approved', 'rejected', 'needs_work', 'comment'];

export interface RunReview {
  id: string;
  runId: string;
  decision: ReviewDecision;
  note?: string;
  reviewer?: string;
  createdAt: string;
}

export interface RunReviewThread {
  reviews: RunReview[];
  status: ReviewDecision | null; // latest non-comment decision, or null if only comments/none
}

function rowToReview(row: any): RunReview {
  return {
    id: String(row.id),
    runId: row.run_id,
    decision: (DECISIONS.includes(row.decision) ? row.decision : 'comment') as ReviewDecision,
    note: row.note || undefined,
    reviewer: row.reviewer || undefined,
    createdAt: row.created_at,
  };
}

export async function listReviews(tenantId: string, runId: string): Promise<RunReviewThread> {
  const { rows } = await pool.query(
    `SELECT id, run_id, decision, note, reviewer, created_at
       FROM api_run_reviews WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC`,
    [tenantId, runId],
  );
  const reviews = rows.map(rowToReview);
  const status = reviews.find((r) => r.decision !== 'comment')?.decision ?? null;
  return { reviews, status };
}

export async function addReview(tenantId: string, reviewer: string, runId: string, decision: unknown, note: unknown): Promise<RunReview> {
  const d = DECISIONS.includes(String(decision) as ReviewDecision) ? (String(decision) as ReviewDecision) : null;
  if (!d) throw new Error('Choose a decision: approve, reject, needs-work, or comment.');
  const text = typeof note === 'string' ? note.slice(0, 4000) : '';
  if (d === 'comment' && !text.trim()) throw new Error('A comment needs some text.');
  const { rows } = await pool.query(
    `INSERT INTO api_run_reviews (tenant_id, run_id, decision, note, reviewer)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, run_id, decision, note, reviewer, created_at`,
    [tenantId, String(runId).slice(0, 100), d, text || null, reviewer],
  );
  return rowToReview(rows[0]);
}
