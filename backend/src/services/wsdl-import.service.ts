/**
 * wsdl-import.service.ts
 * ──────────────────────
 * Deterministic WSDL 1.1 → endpoint-catalogue importer (IQE-046.1).
 *
 * Reads a SOAP service's WSDL and produces ONE endpoint per operation, each
 * with a ready-to-send sample SOAP envelope built from the WSDL/XSD — no LLM
 * involved. This is the SoapUI/ReadyAPI baseline: without it SOAP support is
 * not credible (per the ticket's market note).
 *
 * What it does:
 *   • Parses the WSDL with a real XML DOM (@xmldom/xmldom), namespace-agnostic
 *     (prefixes vary: wsdl:, s:, tns:, none…), so it is robust to real files.
 *   • Walks service → port → binding → portType → operation.
 *   • Detects SOAP 1.1 vs 1.2 per binding and sets the right envelope namespace,
 *     Content-Type and SOAPAction placement.
 *   • Builds a sample request body by expanding the input message's element
 *     (document/literal) or its parts (rpc) against the inline/named XSD types,
 *     with primitive sample values, a depth cap and a cycle guard.
 *   • Returns a reconciling import summary (imported / skipped / total) with a
 *     reason for every skipped operation (AC#5), and a clear error — never a
 *     crash — for an invalid WSDL (AC#4).
 *
 * Each endpoint's URL is the service address plus a `#OperationName` fragment.
 * The fragment is NOT sent on the wire (fetch strips it), so the POST still
 * targets the service endpoint — but it keeps every operation distinct through
 * the method+url de-duplication that all imports pass through (otherwise every
 * operation, being POST to the same address, would collapse into one).
 */
import {
  finalizeEndpoint,
  dedupeEndpoints,
  type ImportResult,
  type ImportedEndpoint,
  type ImportItemResult,
  type ImportSummary,
} from './api-import.service.js';

const SOAP11_ENV = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12_ENV = 'http://www.w3.org/2003/05/soap-envelope';
const MAX_OPERATIONS = 400;
const MAX_DEPTH = 8;
const MAX_NODES = 600;

/* ── DOM helpers (namespace-prefix agnostic) ───────────────────────── */

function localName(node: any): string {
  return String(node?.localName || String(node?.nodeName || '').split(':').pop() || '');
}
/** Direct element children. */
function childElements(parent: any): any[] {
  const out: any[] = [];
  let n = parent?.firstChild;
  while (n) { if (n.nodeType === 1) out.push(n); n = n.nextSibling; }
  return out;
}
/** Direct element children whose local name matches. */
function childrenByLocal(parent: any, name: string): any[] {
  return childElements(parent).filter((c) => localName(c).toLowerCase() === name.toLowerCase());
}
/** Every descendant (and self excluded) whose local name matches. */
function allByLocal(root: any, name: string): any[] {
  const list = root?.getElementsByTagName ? root.getElementsByTagName('*') : [];
  const out: any[] = [];
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (localName(el).toLowerCase() === name.toLowerCase()) out.push(el);
  }
  return out;
}
function attr(el: any, name: string): string {
  if (!el?.getAttribute) return '';
  // Try the plain name first, then any prefixed variant (getAttribute is exact in DOM L2).
  const v = el.getAttribute(name);
  if (v != null && v !== '') return String(v);
  const attrs = el.attributes;
  if (attrs) for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (localName(a).toLowerCase() === name.toLowerCase()) return String(a.value ?? '');
  }
  return '';
}
/** Strip the namespace prefix from a QName ("tns:Add" → "Add"). */
function stripPrefix(qname: string): string {
  return String(qname || '').split(':').pop() || '';
}

/* ── XSD sample-value synthesis ────────────────────────────────────── */

function sampleForType(xsdType: string): string {
  const t = stripPrefix(xsdType).toLowerCase();
  if (/^(int|integer|long|short|byte|unsignedint|unsignedlong|unsignedshort|unsignedbyte|nonnegativeinteger|positiveinteger|negativeinteger|nonpositiveinteger)$/.test(t)) return '0';
  if (/^(decimal|float|double)$/.test(t)) return '0.0';
  if (t === 'boolean') return 'true';
  if (t === 'datetime') return '2025-01-01T00:00:00';
  if (t === 'date') return '2025-01-01';
  if (t === 'time') return '00:00:00';
  if (t === 'duration') return 'P1D';
  if (t === 'anyuri') return 'http://example.com';
  if (t === 'base64binary' || t === 'hexbinary') return '';
  if (t === 'qname' || t === 'ncname' || t === 'name' || t === 'token' || t === 'normalizedstring') return 'name';
  if (t === 'guid' || t === 'uuid') return '00000000-0000-0000-0000-000000000000';
  if (t === 'string' || t === '') return 'string';
  return 'string';
}

/** A schema index: top-level named elements, complexTypes and simpleTypes. */
interface SchemaIndex {
  elements: Map<string, any>;
  complexTypes: Map<string, any>;
  simpleTypes: Map<string, any>;
  targetNamespaceOf: Map<any, string>;
}

function buildSchemaIndex(defs: any): SchemaIndex {
  const idx: SchemaIndex = { elements: new Map(), complexTypes: new Map(), simpleTypes: new Map(), targetNamespaceOf: new Map() };
  for (const schema of allByLocal(defs, 'schema')) {
    const tns = attr(schema, 'targetNamespace');
    for (const el of allByLocal(schema, 'element')) {
      const name = attr(el, 'name');
      if (name && !idx.elements.has(name)) { idx.elements.set(name, el); idx.targetNamespaceOf.set(el, tns); }
    }
    for (const ct of allByLocal(schema, 'complexType')) {
      const name = attr(ct, 'name');
      if (name && !idx.complexTypes.has(name)) idx.complexTypes.set(name, ct);
    }
    for (const st of allByLocal(schema, 'simpleType')) {
      const name = attr(st, 'name');
      if (name && !idx.simpleTypes.has(name)) idx.simpleTypes.set(name, st);
    }
  }
  return idx;
}

/** First enumeration value of a named/inline simpleType, else null. */
function enumValue(simpleType: any): string | null {
  for (const r of allByLocal(simpleType, 'restriction')) {
    const en = childrenByLocal(r, 'enumeration')[0];
    if (en) return attr(en, 'value') || null;
  }
  return null;
}

interface XmlBuilder { lines: string[]; nodes: number; }

function indent(d: number): string { return '  '.repeat(d + 2); }

/** Expand the particles (sequence/all/choice + element children) of a complexType. */
function expandComplexType(ct: any, idx: SchemaIndex, b: XmlBuilder, depth: number, seen: Set<string>): void {
  if (depth > MAX_DEPTH || b.nodes > MAX_NODES) return;
  // complexContent/extension → base type's particles first.
  for (const ext of allByLocal(ct, 'extension')) {
    const base = stripPrefix(attr(ext, 'base'));
    if (base && idx.complexTypes.has(base) && !seen.has('T:' + base)) {
      const nseen = new Set(seen); nseen.add('T:' + base);
      expandComplexType(idx.complexTypes.get(base), idx, b, depth, nseen);
    }
  }
  // Child elements declared under sequence/all/choice (or directly).
  const particles: any[] = [];
  for (const group of ['sequence', 'all', 'choice']) {
    for (const g of allByLocal(ct, group)) for (const e of childrenByLocal(g, 'element')) particles.push(e);
  }
  if (particles.length === 0) for (const e of childrenByLocal(ct, 'element')) particles.push(e);
  for (const el of particles) expandElement(el, idx, b, depth, seen);
}

/** Emit one element (local declaration or named-element ref) and its children. */
function expandElement(el: any, idx: SchemaIndex, b: XmlBuilder, depth: number, seen: Set<string>): void {
  if (b.nodes > MAX_NODES) return;
  b.nodes++;

  // element ref="tns:Something" → resolve to the global element.
  const ref = attr(el, 'ref');
  if (ref) {
    const refName = stripPrefix(ref);
    const g = idx.elements.get(refName);
    if (g && !seen.has('E:' + refName)) {
      const nseen = new Set(seen); nseen.add('E:' + refName);
      expandElement(g, idx, b, depth, nseen);
      return;
    }
    b.lines.push(`${indent(depth)}<${refName}>?</${refName}>`);
    return;
  }

  const name = attr(el, 'name') || 'item';
  const typeName = stripPrefix(attr(el, 'type'));

  // Inline simpleType with an enumeration → use the first allowed value.
  const inlineSimple = childrenByLocal(el, 'simpleType')[0];
  if (inlineSimple) {
    const ev = enumValue(inlineSimple);
    b.lines.push(`${indent(depth)}<${name}>${ev ?? 'string'}</${name}>`);
    return;
  }
  // Inline complexType → recurse into it.
  const inlineComplex = childrenByLocal(el, 'complexType')[0];
  if (inlineComplex) {
    if (depth >= MAX_DEPTH) { b.lines.push(`${indent(depth)}<${name}><!-- ... --></${name}>`); return; }
    b.lines.push(`${indent(depth)}<${name}>`);
    expandComplexType(inlineComplex, idx, b, depth + 1, seen);
    b.lines.push(`${indent(depth)}</${name}>`);
    return;
  }

  // Named type: XSD primitive, named simpleType (enum), or named complexType.
  if (typeName && idx.simpleTypes.has(typeName)) {
    const ev = enumValue(idx.simpleTypes.get(typeName));
    b.lines.push(`${indent(depth)}<${name}>${ev ?? sampleForType(typeName)}</${name}>`);
    return;
  }
  if (typeName && idx.complexTypes.has(typeName)) {
    if (depth >= MAX_DEPTH || seen.has('T:' + typeName)) { b.lines.push(`${indent(depth)}<${name}><!-- ... --></${name}>`); return; }
    const nseen = new Set(seen); nseen.add('T:' + typeName);
    b.lines.push(`${indent(depth)}<${name}>`);
    expandComplexType(idx.complexTypes.get(typeName), idx, b, depth + 1, nseen);
    b.lines.push(`${indent(depth)}</${name}>`);
    return;
  }
  // Primitive / unknown → sample scalar.
  b.lines.push(`${indent(depth)}<${name}>${sampleForType(typeName)}</${name}>`);
}

/** Build the inner Body XML for a document/literal operation from its input element. */
function buildDocumentBody(elementName: string, idx: SchemaIndex): string {
  const el = idx.elements.get(elementName);
  const tns = el ? (idx.targetNamespaceOf.get(el) || '') : '';
  const b: XmlBuilder = { lines: [], nodes: 0 };
  if (el) {
    const inlineComplex = childrenByLocal(el, 'complexType')[0];
    const typeName = stripPrefix(attr(el, 'type'));
    const open = tns ? `<${elementName} xmlns="${tns}">` : `<${elementName}>`;
    if (inlineComplex) {
      b.lines.push(`${indent(-1)}${open}`);
      expandComplexType(inlineComplex, idx, b, 0, new Set());
      b.lines.push(`${indent(-1)}</${elementName}>`);
    } else if (typeName && idx.complexTypes.has(typeName)) {
      b.lines.push(`${indent(-1)}${open}`);
      expandComplexType(idx.complexTypes.get(typeName), idx, b, 0, new Set(['T:' + typeName]));
      b.lines.push(`${indent(-1)}</${elementName}>`);
    } else {
      b.lines.push(`${indent(-1)}${open}${sampleForType(typeName)}</${elementName}>`);
    }
  } else {
    // Element not found in the schema — emit a minimal placeholder (still valid XML).
    b.lines.push(`${indent(-1)}<${elementName}><!-- request --></${elementName}>`);
  }
  return b.lines.join('\n');
}

/** Build the inner Body XML for an rpc operation: wrapper = op name, children = parts. */
function buildRpcBody(opName: string, tns: string, parts: { name: string; type: string }[], idx: SchemaIndex): string {
  const b: XmlBuilder = { lines: [] as string[], nodes: 0 };
  const open = tns ? `<${opName} xmlns="${tns}">` : `<${opName}>`;
  b.lines.push(`${indent(-1)}${open}`);
  for (const p of parts) {
    const tn = stripPrefix(p.type);
    if (tn && idx.complexTypes.has(tn)) {
      b.lines.push(`${indent(0)}<${p.name}>`);
      expandComplexType(idx.complexTypes.get(tn), idx, b, 1, new Set(['T:' + tn]));
      b.lines.push(`${indent(0)}</${p.name}>`);
    } else if (tn && idx.simpleTypes.has(tn)) {
      const ev = enumValue(idx.simpleTypes.get(tn));
      b.lines.push(`${indent(0)}<${p.name}>${ev ?? sampleForType(tn)}</${p.name}>`);
    } else {
      b.lines.push(`${indent(0)}<${p.name}>${sampleForType(tn)}</${p.name}>`);
    }
  }
  b.lines.push(`${indent(-1)}</${opName}>`);
  return b.lines.join('\n');
}

/** Required child element names of a global element (minOccurs ≠ 0 ⇒ required). */
function requiredChildrenOf(elementName: string, idx: SchemaIndex): string[] {
  const el = idx.elements.get(elementName);
  if (!el) return [];
  const typeName = stripPrefix(attr(el, 'type'));
  const ct = childrenByLocal(el, 'complexType')[0] || (typeName ? idx.complexTypes.get(typeName) : null);
  if (!ct) return [];
  const names: string[] = [];
  for (const group of ['sequence', 'all']) {
    for (const g of allByLocal(ct, group)) for (const e of childrenByLocal(g, 'element')) {
      const nm = attr(e, 'name') || stripPrefix(attr(e, 'ref'));
      if (nm && String(attr(e, 'minOccurs') || '1') !== '0') names.push(nm);
    }
  }
  return names;
}

/** Wrap inner body XML in a SOAP envelope for the given SOAP version. */
function wrapEnvelope(innerBody: string, soap12: boolean): string {
  const ns = soap12 ? SOAP12_ENV : SOAP11_ENV;
  return [
    `<soap:Envelope xmlns:soap="${ns}">`,
    `  <soap:Header/>`,
    `  <soap:Body>`,
    innerBody,
    `  </soap:Body>`,
    `</soap:Envelope>`,
  ].join('\n');
}

/* ── Main parse ─────────────────────────────────────────────────────── */

function emptyResult(format: string, warning: string): ImportResult {
  return { endpoints: [], parser: 'wsdl', format, warnings: [warning], summary: { imported: 0, skipped: 0, failed: 0, total: 0 } };
}

export async function parseWsdl(xml: string, sourceName = 'WSDL'): Promise<ImportResult | null> {
  const text = (xml || '').trim();
  // Quick gate: is this even a WSDL? (definitions = 1.1, description = 2.0)
  const looksWsdl = /<([A-Za-z0-9_]+:)?definitions\b/i.test(text) || /<([A-Za-z0-9_]+:)?description\b/i.test(text);
  if (!text || !looksWsdl) return null;

  const xmldomSpec = '@xmldom/xmldom';
  let DOMParser: any;
  try { ({ DOMParser } = await import(xmldomSpec)); }
  catch { return emptyResult('WSDL / SOAP', 'XML support is not installed on the server (npm i @xmldom/xmldom).'); }

  // @xmldom/xmldom THROWS on fatal XML errors (its onError does not suppress
  // them), so a malformed WSDL must be caught here — AC#4: a clear message,
  // never a crash.
  let parseError = '';
  let doc: any;
  try {
    doc = new DOMParser({
      onError: (_level: string, msg: string) => { if (!parseError) parseError = String(msg || '').split('\n')[0]; },
    }).parseFromString(text, 'text/xml');
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    return emptyResult('WSDL / SOAP', `The WSDL is not well-formed XML and could not be parsed: ${msg.split('\n')[0].slice(0, 200)}.`);
  }
  if (!doc) return emptyResult('WSDL / SOAP', `The WSDL could not be parsed as XML${parseError ? ` (${parseError})` : ''}.`);

  const defs = allByLocal(doc, 'definitions')[0];
  const desc = allByLocal(doc, 'description')[0];
  if (!defs) {
    if (desc) return emptyResult('WSDL 2.0', 'WSDL 2.0 (<description>) is not supported yet — only WSDL 1.1 (<definitions>). Convert the service to WSDL 1.1 or add the operations manually.');
    return emptyResult('WSDL / SOAP', `This file is not a valid WSDL 1.1 document — no <definitions> root element was found${parseError ? ` (${parseError})` : ''}.`);
  }

  const defsTns = attr(defs, 'targetNamespace');
  const idx = buildSchemaIndex(defs);

  // messages: name → parts [{ name, element, type }]
  const messages = new Map<string, { name: string; element: string; type: string }[]>();
  for (const m of childrenByLocal(defs, 'message')) {
    const mName = attr(m, 'name');
    if (!mName) continue;
    const parts = childrenByLocal(m, 'part').map((p) => ({
      name: attr(p, 'name') || 'parameters',
      element: stripPrefix(attr(p, 'element')),
      type: stripPrefix(attr(p, 'type')),
    }));
    messages.set(mName, parts);
  }

  // portTypes: name → operations [{ name, inputMsg, outputMsg, doc }]
  const portTypes = new Map<string, Map<string, { input: string; output: string; doc: string }>>();
  for (const pt of childrenByLocal(defs, 'portType')) {
    const ptName = attr(pt, 'name');
    if (!ptName) continue;
    const ops = new Map<string, { input: string; output: string; doc: string }>();
    for (const op of childrenByLocal(pt, 'operation')) {
      const opName = attr(op, 'name');
      if (!opName) continue;
      const input = stripPrefix(attr(childrenByLocal(op, 'input')[0], 'message'));
      const output = stripPrefix(attr(childrenByLocal(op, 'output')[0], 'message'));
      const docEl = childrenByLocal(op, 'documentation')[0];
      ops.set(opName, { input, output, doc: docEl ? String(docEl.textContent || '').trim() : '' });
    }
    portTypes.set(ptName, ops);
  }

  // bindings: name → { portType, soap12, style, operations: name → soapAction }
  interface BindingInfo { portType: string; soap12: boolean; style: string; ops: Map<string, string>; isSoap: boolean; }
  const bindings = new Map<string, BindingInfo>();
  for (const bd of childrenByLocal(defs, 'binding')) {
    const bName = attr(bd, 'name');
    if (!bName) continue;
    const portType = stripPrefix(attr(bd, 'type'));
    // SOAP binding element tells us the version (soap vs soap12 namespace) + style.
    const soapBinding = childElements(bd).find((c) => localName(c) === 'binding' && /wsdl\/soap/i.test(String(c.namespaceURI || '')));
    const isSoap = !!soapBinding;
    const soap12 = !!soapBinding && /soap12|wsdl\/soap12|2003\/05/i.test(String(soapBinding.namespaceURI || ''));
    const style = (soapBinding && attr(soapBinding, 'style')) || 'document';
    const ops = new Map<string, string>();
    for (const op of childrenByLocal(bd, 'operation')) {
      const opName = attr(op, 'name');
      if (!opName) continue;
      const soapOp = childElements(op).find((c) => localName(c) === 'operation' && /wsdl\/soap/i.test(String(c.namespaceURI || '')));
      ops.set(opName, soapOp ? attr(soapOp, 'soapAction') : '');
    }
    bindings.set(bName, { portType, soap12, style, ops, isSoap });
  }

  // services → ports → (binding, address location)
  interface PortInfo { service: string; port: string; binding: string; address: string; soap12Addr: boolean; }
  const ports: PortInfo[] = [];
  for (const svc of childrenByLocal(defs, 'service')) {
    const svcName = attr(svc, 'name');
    for (const port of childrenByLocal(svc, 'port')) {
      const binding = stripPrefix(attr(port, 'binding'));
      const addrEl = childElements(port).find((c) => localName(c) === 'address' && /wsdl\/soap/i.test(String(c.namespaceURI || '')))
        || childElements(port).find((c) => localName(c) === 'address');
      const address = addrEl ? attr(addrEl, 'location') : '';
      const soap12Addr = !!addrEl && /soap12|2003\/05/i.test(String(addrEl.namespaceURI || ''));
      ports.push({ service: svcName, port: attr(port, 'name'), binding, address, soap12Addr });
    }
  }

  // Build endpoints by walking ports → binding → portType operations.
  const endpoints: ImportedEndpoint[] = [];
  const items: ImportItemResult[] = [];
  const source: ImportedEndpoint['source'] = { method: 'wsdl', name: sourceName };
  const seenOp = new Set<string>();

  const resolveElementBody = (msgName: string, opName: string, binding: BindingInfo): string => {
    const parts = messages.get(msgName) || [];
    const isRpc = /rpc/i.test(binding.style);
    if (!isRpc) {
      // document/literal — the first part references a global element.
      const part = parts.find((p) => p.element) || parts[0];
      const elName = part?.element || opName;
      return buildDocumentBody(elName, idx);
    }
    // rpc — wrapper is the operation name, children are the parts (by type).
    return buildRpcBody(opName, defsTns, parts.map((p) => ({ name: p.name, type: p.type })), idx);
  };

  const portsWithSoap = ports.filter((p) => {
    const b = bindings.get(p.binding);
    return b && b.isSoap;
  });

  if (ports.length === 0) {
    return emptyResult('WSDL 1.1', 'The WSDL has no <service> with a port, so there is no endpoint address to call. Add a <service>/<port>/<soap:address> or import the operations manually.');
  }

  for (const p of ports) {
    const binding = bindings.get(p.binding);
    if (!binding) {
      items.push({ name: p.port || p.binding, folderPath: [p.service], outcome: 'skipped', code: 'WSDL_NO_BINDING', message: `Port "${p.port}" references an unknown binding "${p.binding}".` });
      continue;
    }
    if (!binding.isSoap) {
      items.push({ name: p.port || p.binding, folderPath: [p.service], outcome: 'skipped', code: 'WSDL_NOT_SOAP', message: `Port "${p.port}" uses a non-SOAP binding (e.g. HTTP GET/POST) — only SOAP bindings are imported.` });
      continue;
    }
    if (!p.address) {
      items.push({ name: p.port || p.binding, folderPath: [p.service], outcome: 'skipped', code: 'WSDL_NO_ADDRESS', message: `Port "${p.port}" has no <soap:address location="…">, so its operations have no endpoint URL.` });
      continue;
    }
    const pt = portTypes.get(binding.portType);
    if (!pt || pt.size === 0) {
      items.push({ name: p.port || p.binding, folderPath: [p.service], outcome: 'skipped', code: 'WSDL_NO_PORTTYPE', message: `Binding "${p.binding}" references portType "${binding.portType}", which has no operations.` });
      continue;
    }
    const soap12 = binding.soap12 || p.soap12Addr;

    for (const [opName, op] of pt) {
      if (endpoints.length >= MAX_OPERATIONS) break;
      // One endpoint per distinct operation on this address (a service may expose
      // the same portType on two ports — keep the first).
      const dedupeKey = `${p.address}::${opName}`;
      if (seenOp.has(dedupeKey)) continue;
      seenOp.add(dedupeKey);

      const soapAction = binding.ops.get(opName) ?? '';
      const innerBody = op.input ? resolveElementBody(op.input, opName, binding) : buildDocumentBody(opName, idx);
      const body = wrapEnvelope(innerBody, soap12);

      // Headers: SOAP 1.1 → text/xml + SOAPAction header; SOAP 1.2 → application/soap+xml with action= param.
      const headers: { key: string; value: string }[] = [];
      if (soap12) {
        headers.push({ key: 'Content-Type', value: `application/soap+xml; charset=utf-8${soapAction ? `; action="${soapAction}"` : ''}` });
      } else {
        headers.push({ key: 'Content-Type', value: 'text/xml; charset=utf-8' });
        headers.push({ key: 'SOAPAction', value: `"${soapAction}"` });
      }

      const ep = finalizeEndpoint({
        // The #fragment keeps each operation distinct through method+url dedupe;
        // it is not transmitted (fetch strips the fragment), so the POST still
        // targets the service address.
        title: `SOAP ${opName}`,
        method: 'POST',
        url: `${p.address}#${opName}`,
        headers,
        auth: { type: 'none' },
        body,
        expectedStatus: 200,
        description: op.doc || `SOAP ${soap12 ? '1.2' : '1.1'} operation "${opName}" on service "${p.service}".`,
        resource: p.service || binding.portType,
        tags: ['soap', soap12 ? 'soap1.2' : 'soap1.1'],
        style: 'soap',
        operationId: opName,
      }, source);

      if (ep) {
        // Attach the WSDL-derived response contract so a SOAP fault + xmlSchema
        // check can be seeded for this operation (IQE-046.2). finalizeEndpoint
        // returns a fixed shape, so set it on the result.
        const outParts = op.output ? (messages.get(op.output) || []) : [];
        const responseElement = (outParts.find((pp) => pp.element) || outParts[0])?.element || undefined;
        ep.soap = {
          version: soap12 ? '1.2' : '1.1',
          action: soapAction || undefined,
          responseElement,
          responseRequired: responseElement ? requiredChildrenOf(responseElement, idx) : [],
        };
        endpoints.push(ep);
        items.push({ name: opName, folderPath: [p.service, p.port], method: 'POST', url: p.address, outcome: 'imported', code: 'WSDL_OP', message: `SOAP ${soap12 ? '1.2' : '1.1'} operation imported with a sample request.` });
      } else {
        items.push({ name: opName, folderPath: [p.service, p.port], outcome: 'skipped', code: 'WSDL_BAD_ADDRESS', message: `Operation "${opName}" was skipped — the service address "${p.address}" is not an absolute http(s) URL.` });
      }
    }
  }

  const deduped = dedupeEndpoints(endpoints);
  const imported = deduped.length;
  const skipped = items.filter((i) => i.outcome === 'skipped').length;
  const total = items.length;
  const summary: ImportSummary = { imported, skipped, failed: 0, total };

  const warnings: string[] = [];
  if (imported === 0) {
    warnings.push(portsWithSoap.length === 0
      ? 'No SOAP binding was found in the WSDL — only non-SOAP (HTTP) bindings, which are not imported.'
      : 'No operations could be imported. Check that the WSDL has a <portType> with operations bound to a SOAP binding.');
  }

  const soapVersions = new Set(deduped.flatMap((e) => (e.tags || []).filter((t) => t.startsWith('soap1'))));
  const verLabel = soapVersions.size === 2 ? 'SOAP 1.1 + 1.2' : soapVersions.has('soap1.2') ? 'SOAP 1.2' : 'SOAP 1.1';

  return {
    endpoints: deduped,
    parser: 'wsdl',
    format: `WSDL 1.1 (${verLabel})`,
    warnings,
    notice: imported > 0 ? `${imported} SOAP operation${imported === 1 ? '' : 's'} imported from the WSDL, each with a sample request.` : undefined,
    items,
    summary,
  };
}
