/**
 * Unit tests for the deterministic parts of the requirement/spec import path:
 *  - `normalize` (api-spec-parser) emitting the capture fields the LLM returns
 *    (description, businessRules, path/query params, sourceSection).
 *  - `finalizeEndpoint` (api-import) carrying businessRules and folding a
 *    per-endpoint sourceSection + the structured source {key, url} through.
 * Pure-function tests — no DB, no HTTP, no LLM. Run with `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { normalize } from './api-spec-parser.service.js';
import { finalizeEndpoint } from './api-import.service.js';

describe('normalize — capture fields', () => {
  it('emits description, businessRules, params and sourceSection when present', () => {
    const out = normalize({
      title: 'Create order',
      method: 'post',
      url: 'https://api.example.com/orders',
      description: '  Create an order for a customer.  ',
      businessRules: 'Reject orders over the credit limit; 409 on duplicate order id.',
      pathParams: [{ name: 'id', example: '1', required: true }],
      queryParams: [{ name: 'status', example: 'active', required: false }, { bad: true }],
      sourceSection: 'FR-12 / §4.3 Orders',
    });
    expect(out).not.toBeNull();
    expect(out!.description).toBe('Create an order for a customer.');
    expect(out!.businessRules).toContain('credit limit');
    expect(out!.pathParams).toEqual([{ name: 'id', example: '1', required: true }]);
    // The malformed param (no name) is dropped; the valid one survives.
    expect(out!.queryParams).toEqual([{ name: 'status', example: 'active', required: false }]);
    expect(out!.sourceSection).toBe('FR-12 / §4.3 Orders');
  });

  it('leaves capture fields undefined when the model gives nothing', () => {
    const out = normalize({ method: 'get', url: 'https://api.example.com/health' });
    expect(out).not.toBeNull();
    expect(out!.description).toBeUndefined();
    expect(out!.businessRules).toBeUndefined();
    expect(out!.pathParams).toBeUndefined();
    expect(out!.queryParams).toBeUndefined();
    expect(out!.sourceSection).toBeUndefined();
  });

  it('clamps an over-long businessRules string', () => {
    const out = normalize({ method: 'get', url: 'https://api.example.com/x', businessRules: 'r'.repeat(5000) });
    expect(out!.businessRules!.length).toBe(4000);
  });
});

describe('finalizeEndpoint — businessRules + structured source', () => {
  it('carries businessRules and folds sourceSection into the source', () => {
    const ep = finalizeEndpoint({
      method: 'POST',
      url: 'https://api.example.com/orders',
      businessRules: 'Must reject duplicates.',
      sourceSection: 'FR-12',
      source: { method: 'jira', name: 'Jira PROJ-7: Create order', key: 'PROJ-7', url: 'https://jira.example.com/browse/PROJ-7' },
    });
    expect(ep).not.toBeNull();
    expect(ep!.businessRules).toBe('Must reject duplicates.');
    expect(ep!.source).toEqual({
      method: 'jira',
      name: 'Jira PROJ-7: Create order',
      key: 'PROJ-7',
      url: 'https://jira.example.com/browse/PROJ-7',
      section: 'FR-12',
    });
  });

  it('does not overwrite a section the source already carries', () => {
    const ep = finalizeEndpoint({
      method: 'GET',
      url: 'https://api.example.com/x',
      sourceSection: 'new',
      source: { method: 'frd', name: 'reqs.pdf', section: 'existing' },
    });
    expect(ep!.source!.section).toBe('existing');
  });
});
