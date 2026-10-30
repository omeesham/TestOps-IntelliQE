/**
 * Unit tests for the document extraction model (requirementAgent) and the
 * document-verification skill selection (skills.selectSkills).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseDocumentExtraction } from '../src/agents/requirementAgent.js';
import { selectSkills } from '../src/agents/skills.js';
import type { ExploredApp } from '../src/agents/state.js';

test('extracted fields get unique EXT ids across features, typed values and safe defaults', () => {
  const docs = normaliseDocumentExtraction([
    { feature: 'Labor Ticket Scanning', documentType: 'Handwritten labor ticket (PDF)', inputs: ['pdf'], trigger: 'Scan',
      fields: [
        { id: 'EXT-01', name: 'Ticket Number', dataType: 'code', risk: 'High', required: true, showsConfidence: true },
        { id: 'EXT-01', name: 'Project', dataType: 'barcode', risk: 'Critical', required: 'yes' },
        { name: '  ' },
      ] },
    { feature: 'Delivery Note Scanning', fields: [{ name: 'Order Number', dataType: 'code', risk: 'High' }] },
    { feature: 'No fields' },
    'not a document',
  ]);
  assert.equal(docs.length, 2, 'features without fields and malformed entries are dropped');
  assert.deepEqual(docs.flatMap((d) => d.fields.map((f) => f.id)), ['EXT-01', 'EXT-02', 'EXT-03']);
  const project = docs[0].fields[1];
  assert.equal(project.dataType, 'text', 'an unknown data type falls back to text');
  assert.equal(project.risk, 'Medium', 'an unknown risk falls back to Medium');
  assert.equal(project.required, false, 'only a real true marks a field required');
  assert.equal(docs[0].fields[0].required, true);
  assert.equal(docs[1].documentType, 'Document');
  assert.deepEqual(docs[1].ruleIds, []);
});

test('anything that is not a list gives no document features', () => {
  assert.deepEqual(normaliseDocumentExtraction(undefined), []);
  assert.deepEqual(normaliseDocumentExtraction({ feature: 'x' }), []);
});

const explored = (documentFeatures: ExploredApp['documentFeatures']): ExploredApp => ({
  baseUrl: 'https://app.test', pages: [], detectedFeatures: [], authDetected: false, notes: [], documentFeatures,
});

test('the document skill is picked for an explored scanning screen, and only then', () => {
  const signal = { url: 'https://app.test/scan', title: 'Labor Ticket Scanning', upload: ['accepts .pdf'], triggers: ['Scan'], confidenceFields: ['Ticket Number'], tables: [], outputFields: [] };
  assert.ok(selectSkills({ requirements: '', exploredApp: explored([signal]) }).includes('document-verification'));
  assert.ok(!selectSkills({ requirements: 'Scanning of labor ticket PDFs with OCR', exploredApp: explored([]) }).includes('document-verification'),
    'an explored app decides from its screens, not from synthesized text');
});

test('pasted requirements pick the document skill only for document extraction wording', () => {
  assert.ok(selectSkills({ requirements: 'Users upload labor ticket PDFs; OCR extracts the hours with a confidence score.', exploredApp: null }).includes('document-verification'));
  assert.ok(!selectSkills({ requirements: 'Users upload a profile photo and edit their name.', exploredApp: null }).includes('document-verification'));
});
