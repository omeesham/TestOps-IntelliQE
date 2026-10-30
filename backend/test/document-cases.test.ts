/**
 * Unit tests for document test cases in the generator: data-driven checks,
 * EXT coverage tracking and the accuracy / confidence categories.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceDataDriven, coveredIds, categoryFor } from '../src/agents/generatorAgent.js';
import { normaliseCategory } from '../src/utils/test-case-fields.js';

test('a data-driven check keeps its documents, fields and oracle', () => {
  assert.deepEqual(
    coerceDataDriven({ oracle: 'baseline', documentClasses: ['neat handwriting', ' faint scan '], fields: 'Ticket Number' }),
    { oracle: 'baseline', documentClasses: ['neat handwriting', 'faint scan'], fields: ['Ticket Number'] },
  );
});

test('an unknown oracle falls back to the answer key; an empty check is no check', () => {
  assert.equal(coerceDataDriven({ oracle: 'guess', fields: ['Project'] })?.oracle, 'answer-key');
  assert.equal(coerceDataDriven({ oracle: 'answer-key' }), undefined);
  assert.equal(coerceDataDriven(undefined), undefined);
});

test('coverage counts extracted-field ids next to field and business rule ids', () => {
  const ids = coveredIds([{ traceabilityId: 'EXT-01, ext-03' }, { traceabilityId: 'FLD-02; BR-01' }, { traceabilityId: 'REQ-OCR-01' }]);
  assert.deepEqual([...ids].sort(), ['BR-01', 'EXT-01', 'EXT-03', 'FLD-02']);
});

test('accuracy and confidence are categories the generator and the save path accept', () => {
  assert.equal(categoryFor('accuracy', 'positive'), 'accuracy');
  assert.equal(categoryFor('Confidence', 'positive'), 'confidence');
  assert.equal(normaliseCategory('accuracy'), 'accuracy');
  assert.equal(normaliseCategory('confidence'), 'confidence');
});
