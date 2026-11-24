/**
 * api-flow-bridge.protocol.test.ts
 * Proves the endpoint→flow bridge seeds PROTOCOL-APPROPRIATE body assertions
 * (not just status + JSON path) when it turns an imported catalogue into runnable
 * flows: GraphQL → `graphql`, SOAP → `soapFault`(+`xmlSchema`), XML/HTML →
 * `contentType`, JSON → `noError`. Deterministic, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  detectResponseShape,
  protocolChecks,
  suggestIntegrationFlows,
} from './api-flow-bridge.service';
import type { ImportedEndpoint } from './api-import.service';

/** Minimal valid ImportedEndpoint with overridable fields. */
function ep(p: Partial<ImportedEndpoint>): ImportedEndpoint {
  return {
    title: p.title || `${p.method || 'GET'} ${p.url || '/'}`,
    method: p.method || 'GET',
    url: p.url || 'https://api.example.com/',
    headers: p.headers || [],
    auth: p.auth || { type: 'none' },
    ...p,
  } as ImportedEndpoint;
}

const kinds = (cs: { kind: string }[]) => cs.map((c) => c.kind);

describe('detectResponseShape', () => {
  it('GraphQL from style', () => {
    expect(detectResponseShape(ep({ style: 'graphql', method: 'POST', url: 'https://api.example.com/graphql' }))).toBe('graphql');
  });
  it('SOAP from style or soap metadata', () => {
    expect(detectResponseShape(ep({ style: 'soap' }))).toBe('soap');
    expect(detectResponseShape(ep({ soap: { version: '1.1' } }))).toBe('soap');
  });
  it('XML from a documented response sample', () => {
    expect(detectResponseShape(ep({ expectedResponse: '<?xml version="1.0"?><Note><to>x</to></Note>' }))).toBe('xml');
  });
  it('HTML from a documented response sample', () => {
    expect(detectResponseShape(ep({ expectedResponse: '<!doctype html><html><body>hi</body></html>' }))).toBe('html');
  });
  it('JSON from a documented response sample', () => {
    expect(detectResponseShape(ep({ expectedResponse: '{"id":1}' }))).toBe('json');
  });
  it('falls back to a content-type / accept header', () => {
    expect(detectResponseShape(ep({ headers: [{ key: 'Accept', value: 'application/xml' }] }))).toBe('xml');
    expect(detectResponseShape(ep({ headers: [{ key: 'Content-Type', value: 'text/html' }] }))).toBe('html');
  });
  it('is unknown when there is no signal', () => {
    expect(detectResponseShape(ep({}))).toBe('unknown');
  });
});

describe('protocolChecks', () => {
  it('GraphQL → a graphql no-errors check', () => {
    expect(kinds(protocolChecks(ep({ style: 'graphql' })))).toEqual(['graphql']);
  });
  it('SOAP with a WSDL response element → soapFault + xmlSchema', () => {
    const cs = protocolChecks(ep({ style: 'soap', soap: { version: '1.2', responseElement: 'AddResponse', responseRequired: ['AddResult'] } }));
    expect(kinds(cs)).toEqual(['soapFault', 'xmlSchema']);
    const xml = cs.find((c) => c.kind === 'xmlSchema')!;
    expect(JSON.parse(String(xml.schema))).toEqual({ element: 'AddResponse', required: ['AddResult'] });
  });
  it('SOAP without a known contract → soapFault only', () => {
    expect(kinds(protocolChecks(ep({ soap: { version: '1.1' } })))).toEqual(['soapFault']);
  });
  it('XML → contentType contains xml', () => {
    const cs = protocolChecks(ep({ expectedResponse: '<?xml version="1.0"?><a/>' }));
    expect(cs).toEqual([{ kind: 'contentType', value: 'xml' }]);
  });
  it('HTML → contentType contains html', () => {
    const cs = protocolChecks(ep({ expectedResponse: '<!doctype html><html></html>' }));
    expect(cs).toEqual([{ kind: 'contentType', value: 'html' }]);
  });
  it('JSON → noError', () => {
    expect(kinds(protocolChecks(ep({ expectedResponse: '{"ok":true}' })))).toEqual(['noError']);
  });
  it('unknown → no extra checks', () => {
    expect(protocolChecks(ep({}))).toEqual([]);
  });
});

describe('wiring — suggestIntegrationFlows seeds protocol checks into the smoke flow', () => {
  const flows = suggestIntegrationFlows([
    ep({ method: 'GET', url: 'https://api.example.com/feed', expectedResponse: '<?xml version="1.0"?><feed/>' }),
    ep({ method: 'GET', url: 'https://api.example.com/page', expectedResponse: '<!doctype html><html></html>' }),
    ep({ method: 'GET', url: 'https://api.example.com/items', expectedResponse: '{"items":[]}' }),
  ]);
  const smoke = flows.find((f) => /smoke/i.test(f.name));

  it('produces a smoke flow covering all three reads', () => {
    expect(smoke).toBeDefined();
    expect(smoke!.steps.length).toBe(3);
  });
  it('each read carries its protocol-appropriate body assertion', () => {
    const byPath = (p: string) => smoke!.steps.find((s) => s.url!.includes(p))!;
    expect(kinds(byPath('/feed').checks || [])).toContain('contentType');
    expect(kinds(byPath('/page').checks || [])).toContain('contentType');
    expect(kinds(byPath('/items').checks || [])).toContain('noError');
  });
});
