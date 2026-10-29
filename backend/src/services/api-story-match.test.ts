/**
 * Unit tests for the pure story-agent matching helpers.
 *
 * These cover the deterministic pass that guarantees a mapped endpoint is always
 * one the user actually has, and that matching is method-aware (the same path as
 * a GET and a POST must stay two distinct endpoints).
 */
import { describe, it, expect } from 'vitest';
import { normPath, endpointKey, resolveRefs } from './api-story-match.js';

describe('normPath', () => {
  it('leaves a simple path unchanged', () => {
    expect(normPath('/posts')).toBe('/posts');
  });

  it('strips scheme + host', () => {
    expect(normPath('https://api.example.com/posts')).toBe('/posts');
  });

  it('strips query and fragment', () => {
    expect(normPath('/posts?page=2&sort=asc')).toBe('/posts');
    expect(normPath('/posts#section')).toBe('/posts');
  });

  it('collapses numeric, templated, :param, uuid and long-hex id segments to {}', () => {
    expect(normPath('/posts/42')).toBe('/posts/{}');
    expect(normPath('/posts/{id}')).toBe('/posts/{}');
    expect(normPath('/posts/:id')).toBe('/posts/{}');
    expect(normPath('/users/550e8400-e29b-41d4-a716-446655440000')).toBe('/users/{}');
    expect(normPath('/users/deadbeefdeadbeef')).toBe('/users/{}');
  });

  it('makes a bare path and an absolute concretised url compare equal', () => {
    expect(normPath('/posts/1')).toBe(normPath('https://api/posts/42?x=1'));
  });

  it('lower-cases literal segments, prepends a slash, and trims trailing slashes', () => {
    expect(normPath('Posts/Comments')).toBe('/posts/comments');
    expect(normPath('/posts/')).toBe('/posts');
  });

  it('is total on empty / nullish input', () => {
    expect(normPath('')).toBe('/');
    // the body coerces with String(u || ''), so these must not throw
    expect(normPath(undefined as unknown as string)).toBe('/');
    expect(normPath(null as unknown as string)).toBe('/');
  });
});

describe('endpointKey', () => {
  it('is method + canonical path, method upper-cased', () => {
    expect(endpointKey('get', '/posts/1')).toBe('GET /posts/{}');
    expect(endpointKey('POST', '/posts')).toBe('POST /posts');
  });

  it('defaults a missing method to GET', () => {
    expect(endpointKey(undefined, '/posts')).toBe('GET /posts');
  });

  it('keeps the same path under two methods distinct', () => {
    expect(endpointKey('GET', '/posts')).not.toBe(endpointKey('POST', '/posts'));
  });
});

describe('resolveRefs', () => {
  // A catalogue of two endpoints sharing the path /posts (GET e1, POST e2) plus
  // a parametrised GET /posts/{id} (e3) — the exact shape the method-aware
  // matching is meant to disambiguate.
  const idToEp = new Set(['e1', 'e2', 'e3']); // satisfies { has(key): boolean }
  const keyToId = new Map<string, string>([
    ['GET /posts', 'e1'],
    ['POST /posts', 'e2'],
    ['GET /posts/{}', 'e3'],
  ]);
  const pathToIds = new Map<string, string[]>([
    ['/posts', ['e1', 'e2']],
    ['/posts/{}', ['e3']],
  ]);
  const resolve = (raw: unknown) => resolveRefs(raw, idToEp, keyToId, pathToIds);

  it('resolves an exact id', () => {
    expect(resolve('e2')).toEqual(['e2']);
  });

  it('resolves an id embedded in brackets or prose', () => {
    expect(resolve('[e3]')).toEqual(['e3']);
    expect(resolve('endpoint e1 handles this')).toEqual(['e1']);
  });

  it('resolves a method-prefixed form to the right method (not the other)', () => {
    expect(resolve('POST /posts')).toEqual(['e2']);
    expect(resolve('GET /posts')).toEqual(['e1']);
  });

  it('matches the method-prefixed form after normalising host/query/ids', () => {
    expect(resolve('GET https://api.example.com/posts/99?x=1')).toEqual(['e3']);
  });

  it('a bare path (no method) maps to every method on that path', () => {
    expect(resolve('/posts')).toEqual(['e1', 'e2']);
  });

  it('accepts a single value or an array, and de-dupes', () => {
    expect(resolve(['e1', 'e1', 'POST /posts'])).toEqual(['e1', 'e2']);
  });

  it('drops tokens that match nothing in the catalogue', () => {
    expect(resolve(['e9', 'DELETE /unknown', '/nope'])).toEqual([]);
  });

  it('ignores empty / nullish input without throwing', () => {
    expect(resolve(null)).toEqual([]);
    expect(resolve(undefined)).toEqual([]);
    expect(resolve('')).toEqual([]);
    expect(resolve(['', '   '])).toEqual([]);
  });

  it('caps the result at 8 ids', () => {
    const many = new Set(Array.from({ length: 20 }, (_, i) => `e${i + 1}`));
    const paths = new Map<string, string[]>([['/wide', Array.from({ length: 20 }, (_, i) => `e${i + 1}`)]]);
    const out = resolveRefs('/wide', many, new Map(), paths);
    expect(out).toHaveLength(8);
  });
});
