/**
 * Unit tests for the CI CLI argument parser (ci/intelliqe-ci.mjs).
 * The CLI guards main() so importing it here does not execute it.
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — zero-dep .mjs CLI without a type declaration
import { parseArgs } from '../../../ci/intelliqe-ci.mjs';

describe('ci CLI parseArgs', () => {
  it('parses a single flow with a junit path', () => {
    const a = parseArgs(['--flow', 'abc123', '--junit', 'out.xml']);
    expect(a.flow).toBe('abc123');
    expect(a.junit).toBe('out.xml');
  });

  it('splits a comma-separated suite list', () => {
    const a = parseArgs(['--suite', 'id1, id2 ,id3']);
    expect(a.suite).toEqual(['id1', 'id2', 'id3']);
  });

  it('defaults junit to junit.xml and honours --no-junit', () => {
    expect(parseArgs(['--flow', 'x']).junit).toBe('junit.xml');
    expect(parseArgs(['--flow', 'x', '--no-junit']).junit).toBe('');
  });

  it('parses boolean flags', () => {
    const a = parseArgs(['--flow', 'x', '--allow-writes', '--stop-on-failure']);
    expect(a.allowWrites).toBe(true);
    expect(a.stopOnFailure).toBe(true);
  });

  it('sets help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});
