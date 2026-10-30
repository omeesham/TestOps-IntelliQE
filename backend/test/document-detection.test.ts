/**
 * Unit tests for document-screen detection in Explore (detectDocumentFeatures).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDocumentFeatures } from '../src/agents/exploreAgent.js';

type Snapshot = Parameters<typeof detectDocumentFeatures>[0][number];
const page = (over: Partial<Snapshot>): Snapshot => ({
  url: 'https://app.test/x', title: 'X', headings: [], forms: [], buttons: [], links: [], navItems: [], ...over,
});

const HEADER = ['Ticket Number', 'Order Status', 'User', 'Show Occurrence', 'Show Name', 'Project', 'Booth Number',
  'Customer Name', 'Order / Line', 'Order Received Date', 'Item', 'Start Date'];

test('a labor ticket scanning screen (upload, Scan, confidence, table) is a document feature', () => {
  const [sig, ...rest] = detectDocumentFeatures([page({
    url: 'https://uat.test/document-scanning/011088906',
    title: 'Labor Ticket Scanning',
    forms: [{ fields: [{ name: 'files', type: 'file', required: false, constraints: ['accepts .pdf', 'multiple'] }] }],
    buttons: ['Choose Files', 'Scan'],
    confidenceLabels: HEADER,
    tables: [{ title: 'Scanning Target Area', headers: ['Worker Name', 'Date', 'Start Time', 'Stop Time', 'ST Hrs', 'OT Hrs', 'DT Hrs'] }],
  })]);
  assert.equal(rest.length, 0);
  assert.deepEqual(sig.triggers, ['Scan']);
  assert.deepEqual(sig.upload, ['accepts .pdf', 'multiple']);
  assert.equal(sig.confidenceFields.length, 12);
  assert.equal(sig.tables[0].headers.length, 7);
});

test('an upload with read-only output fields and no trigger button is detected', () => {
  const ro = (name: string) => ({ name, type: 'text', required: false, label: name, constraints: ['read-only'] });
  const sigs = detectDocumentFeatures([page({
    forms: [{ fields: [{ name: 'doc', type: 'file', required: true }, ro('Ticket Number'), ro('Project'), ro('Hours')] }],
    buttons: ['Upload'],
  })]);
  assert.equal(sigs.length, 1);
  assert.deepEqual(sigs[0].outputFields, ['Ticket Number', 'Project', 'Hours']);
});

test('a "Read-only view" button is not a read trigger', () => {
  assert.equal(detectDocumentFeatures([page({
    forms: [{ fields: [{ name: 'contract', type: 'file', required: false }] }],
    buttons: ['Read-only view', 'Save'],
  })]).length, 0);
});

test('a plain upload, a list page with a photo upload, and pages without a file input are not document features', () => {
  assert.equal(detectDocumentFeatures([
    page({ forms: [{ fields: [{ name: 'avatar', type: 'file', required: false }, { name: 'bio', type: 'text', required: false }] }], buttons: ['Save'] }),
    page({ forms: [{ fields: [{ name: 'photo', type: 'file', required: false }] }], buttons: ['Save'], tables: [{ headers: ['Name', 'Email', 'Role'] }] }),
    page({ forms: [{ fields: [{ name: 'user', type: 'text', required: true }, { name: 'pw', type: 'password', required: true }] }], buttons: ['Sign in'], confidenceLabels: ['x'] }),
  ]).length, 0);
});
