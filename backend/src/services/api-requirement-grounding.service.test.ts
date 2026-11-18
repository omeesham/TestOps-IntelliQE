import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the BRD/FRD services so the grounding assembly is tested in isolation
// (no DB). Each mock returns the { document, requirements } shape the real
// getters return.
const getBrdDocument = vi.fn();
const getFrdDocument = vi.fn();
vi.mock('./api-brd.service.js', () => ({ getBrdDocument: (...a: any[]) => getBrdDocument(...a) }));
vi.mock('./api-frd.service.js', () => ({ getFrdDocument: (...a: any[]) => getFrdDocument(...a) }));

const { assembleRequirementGrounding, hasRequirementRefs } = await import('./api-requirement-grounding.service.js');

beforeEach(() => {
  getBrdDocument.mockReset();
  getFrdDocument.mockReset();
});

describe('hasRequirementRefs', () => {
  it('is false for null / empty refs', () => {
    expect(hasRequirementRefs(null)).toBe(false);
    expect(hasRequirementRefs(undefined)).toBe(false);
    expect(hasRequirementRefs({})).toBe(false);
    expect(hasRequirementRefs({ brdDocIds: [], frdDocIds: [] })).toBe(false);
  });
  it('is true when any id is present', () => {
    expect(hasRequirementRefs({ brdDocIds: ['b1'] })).toBe(true);
    expect(hasRequirementRefs({ frdDocIds: ['f1'] })).toBe(true);
  });
});

describe('assembleRequirementGrounding', () => {
  it('returns empty string when there are no refs (and never touches the DB)', async () => {
    const out = await assembleRequirementGrounding('t1', null);
    expect(out).toBe('');
    expect(getBrdDocument).not.toHaveBeenCalled();
    expect(getFrdDocument).not.toHaveBeenCalled();
  });

  it('folds BRD acceptance criteria + business rules into the grounding', async () => {
    getBrdDocument.mockResolvedValue({
      document: { id: 'b1', name: 'Payments BRD' },
      requirements: [
        { brId: 'BR-1', title: 'Refund a charge', description: 'A charge can be refunded within 30 days.',
          rules: ['Refund only within 30 days', 'Only original payer'],
          acceptanceCriteria: ['Given a charge When refunded within 30 days Then status is refunded'] },
      ],
    });
    const out = await assembleRequirementGrounding('t1', { brdDocIds: ['b1'] });
    expect(getBrdDocument).toHaveBeenCalledWith('t1', 'b1');
    expect(out).toContain('BUSINESS REQUIREMENTS — Payments BRD');
    expect(out).toContain('BR-1: Refund a charge');
    expect(out).toContain('Business rules: Refund only within 30 days; Only original payer');
    expect(out).toContain('Acceptance criteria: Given a charge When refunded within 30 days Then status is refunded');
  });

  it('folds FRD endpoints, responses and acceptance criteria', async () => {
    getFrdDocument.mockResolvedValue({
      document: { id: 'f1', name: 'Orders FRD' },
      requirements: [
        { frId: 'FR-9', title: 'Create order',
          endpoints: [{ method: 'post', path: '/orders' }],
          responses: [{ status: '201', description: 'Created' }],
          acceptanceCriteria: ['Given a valid cart When POST /orders Then 201'] },
      ],
    });
    const out = await assembleRequirementGrounding('t1', { frdDocIds: ['f1'] });
    expect(out).toContain('FUNCTIONAL REQUIREMENTS — Orders FRD');
    expect(out).toContain('Endpoints: POST /orders');
    expect(out).toContain('Expected responses: 201 Created');
    expect(out).toContain('Acceptance criteria: Given a valid cart When POST /orders Then 201');
  });

  it('skips documents that do not resolve, and tolerates a getter throwing', async () => {
    getBrdDocument.mockResolvedValueOnce(null);                 // b1 → missing
    getBrdDocument.mockRejectedValueOnce(new Error('db down')); // b2 → throws
    const out = await assembleRequirementGrounding('t1', { brdDocIds: ['b1', 'b2'] });
    expect(out).toBe('');
  });

  it('caps the grounding length', async () => {
    getBrdDocument.mockResolvedValue({
      document: { id: 'b1', name: 'Big BRD' },
      requirements: Array.from({ length: 200 }, (_, i) => ({
        brId: `BR-${i}`, title: 'x'.repeat(200),
        acceptanceCriteria: Array.from({ length: 20 }, () => 'y'.repeat(200)),
      })),
    });
    const out = await assembleRequirementGrounding('t1', { brdDocIds: ['b1'] });
    expect(out.length).toBeLessThanOrEqual(6000);
  });
});
