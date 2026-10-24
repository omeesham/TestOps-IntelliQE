/**
 * Unit tests for prompt suggestions (services/prompt-assist.service.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSuggestions, buildAssistPrompt, AssistRateLimit, MAX_PROMPT_CHARS } from '../src/services/prompt-assist.service.js';

test('cleanSuggestions keeps up to 3 well-formed suggestions with bounded lengths', () => {
  const out = cleanSuggestions({
    suggestions: [
      { title: 'Focused', why: 'Same scope', prompt: '  Test the booking form  ' },
      { title: 'Empty', prompt: '   ' },
      null,
      { title: 'x'.repeat(100), why: 'y'.repeat(300), prompt: 'z'.repeat(MAX_PROMPT_CHARS + 50) },
      { prompt: 'Third' },
      { prompt: 'Fourth' },
    ],
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].prompt, 'Test the booking form');
  assert.equal(out[1].title.length, 40);
  assert.equal(out[1].why.length, 160);
  assert.equal(out[1].prompt.length, MAX_PROMPT_CHARS);
  assert.equal(out[2].title, 'Suggestion');
});

test('cleanSuggestions accepts a bare array and rejects junk', () => {
  assert.equal(cleanSuggestions([{ prompt: 'One' }]).length, 1);
  assert.deepEqual(cleanSuggestions('not json'), []);
  assert.deepEqual(cleanSuggestions(undefined), []);
});

test('the assist prompt carries names only and the no-new-scope rule', () => {
  const p = buildAssistPrompt('Test the booking page', { appName: 'EventHub', environment: 'QA' });
  assert.match(p, /Application: EventHub/);
  assert.match(p, /Do NOT add features, screens, fields, limits or rules/);
  assert.doesNotMatch(p, /https?:\/\//);
});

test('AssistRateLimit allows 10 calls per minute per user and forgets idle users', () => {
  const rl = new AssistRateLimit(10, 60_000);
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) assert.ok(rl.allow('ana', t0 + i));
  assert.equal(rl.allow('ana', t0 + 20), false);
  assert.ok(rl.allow('ben', t0 + 30));
  assert.ok(rl.allow('ana', t0 + 60_001));
  rl.allow('ana', t0 + 200_000);
  assert.equal(rl.size, 1, 'idle users are removed');
});
