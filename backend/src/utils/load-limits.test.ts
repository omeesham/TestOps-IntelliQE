/**
 * Unit tests for load-runner limit resolution.
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { resolveLoadLimits, LOAD_DEFAULTS, LOAD_HARD } from './load-limits.js';

describe('resolveLoadLimits', () => {
  it('uses the raised defaults when nothing is set', () => {
    const l = resolveLoadLimits({});
    expect(l.maxConcurrency).toBe(250);
    expect(l).toEqual(LOAD_DEFAULTS);
  });

  it('honours a valid override', () => {
    const l = resolveLoadLimits({ LOADTEST_MAX_CONCURRENCY: '500', LOADTEST_MAX_TOTAL_REQUESTS: '50000' });
    expect(l.maxConcurrency).toBe(500);
    expect(l.maxTotalRequests).toBe(50_000);
  });

  it('clamps an override to the hard ceiling', () => {
    const l = resolveLoadLimits({ LOADTEST_MAX_CONCURRENCY: '999999' });
    expect(l.maxConcurrency).toBe(LOAD_HARD.maxConcurrency);
  });

  it('falls back to the default on an invalid or non-positive value', () => {
    expect(resolveLoadLimits({ LOADTEST_MAX_CONCURRENCY: 'abc' }).maxConcurrency).toBe(250);
    expect(resolveLoadLimits({ LOADTEST_MAX_CONCURRENCY: '0' }).maxConcurrency).toBe(250);
    expect(resolveLoadLimits({ LOADTEST_MAX_CONCURRENCY: '-5' }).maxConcurrency).toBe(250);
  });

  it('keeps the hard request cap within its floor and ceiling', () => {
    expect(resolveLoadLimits({ LOADTEST_HARD_REQUEST_CAP: '10' }).hardRequestCap).toBe(1_000);        // floor
    expect(resolveLoadLimits({ LOADTEST_HARD_REQUEST_CAP: '9999999999' }).hardRequestCap).toBe(LOAD_HARD.hardRequestCap);
  });
});
