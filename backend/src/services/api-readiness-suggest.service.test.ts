/**
 * Unit tests for the readiness suggestion service (deterministic / no-LLM path).
 * Proves the suggestion is always complete and shaped to pass the readiness gate
 * (mirrors the frontend apiValidation.ts rules). Run with `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { suggestReadiness } from './api-readiness-suggest.service.js';

/** The gate rules from apiValidation.ts, re-stated so the suggestion is checked. */
function passesGate(s: { description: string; expectedStatus: number; expectedResponse: string; businessRules: string; body: string }, method: string): boolean {
  const okPurpose = s.description.trim().length >= 12;
  const okStatus = Number.isInteger(s.expectedStatus) && s.expectedStatus > 0;
  let okJson = false;
  try { JSON.parse(s.expectedResponse); okJson = s.expectedResponse.trim().length > 0; } catch { okJson = false; }
  const okRules = s.businessRules.trim().length >= 8;
  const write = method === 'POST' || method === 'PUT' || method === 'PATCH';
  const okBody = !write || !!s.body.trim();
  return okPurpose && okStatus && okJson && okRules && okBody;
}

describe('suggestReadiness (no LLM)', () => {
  it('returns a gate-passing suggestion for a GET', async () => {
    const { suggestion, source } = await suggestReadiness({ method: 'GET', url: 'https://api.example.com/users/1' });
    expect(source).toBe('heuristic');
    expect(passesGate(suggestion, 'GET')).toBe(true);
    expect(suggestion.expectedStatus).toBe(200);
  });

  it('suggests 201 and a request body for a POST', async () => {
    const { suggestion } = await suggestReadiness({ method: 'POST', url: 'https://api.example.com/orders' });
    expect(suggestion.expectedStatus).toBe(201);
    expect(suggestion.body.trim().length).toBeGreaterThan(0);
    expect(() => JSON.parse(suggestion.body)).not.toThrow();
    expect(passesGate(suggestion, 'POST')).toBe(true);
  });

  it('always yields a valid-JSON expected response', async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const { suggestion } = await suggestReadiness({ method, url: 'https://api.example.com/things/9' });
      expect(() => JSON.parse(suggestion.expectedResponse)).not.toThrow();
      expect(passesGate(suggestion, method)).toBe(true);
    }
  });

  it('names the resource from the URL in the purpose and rules', async () => {
    const { suggestion } = await suggestReadiness({ method: 'GET', url: 'https://api.example.com/invoices/42' });
    expect(suggestion.description.toLowerCase()).toContain('invoice');
    expect(suggestion.businessRules.toLowerCase()).toContain('invoice');
  });
});
