/**
 * api-multimodal.service.ts
 * ─────────────────────────
 * Multimodal inputs → an API test brief. Designers hand over a Figma export, a
 * PM drops a screenshot of a flow, a QA pastes a screen-recording transcript.
 * This reads those artifacts (images via the vision model, Figma/transcript as
 * text) and extracts the API-relevant behaviour: the flows a user takes, the
 * fields and validations implied, and which catalogue endpoints they map to —
 * then emits a brief the EXISTING generator understands.
 *
 * Standalone and opt-in. Images are only honoured on an Anthropic model (the
 * vision path in runLLM); with a non-vision provider the caller gets a clear
 * error. The design → generate → execute → heal pipeline is untouched.
 */
import { runLLM, parseJsonFromResponse, type LlmConfig, type LlmImage } from '../agents/claude-runner.js';
import type { NlBrief } from './api-nl-author.service.js';

export interface MultimodalEndpoint { method: string; url: string; title?: string }

export interface MultimodalInput {
  /** base64 images (data stripped of any data: prefix) with their media type. */
  images?: { data: string; mediaType: string }[];
  /** Figma export JSON or any design text. */
  figma?: string;
  /** A video/screen-recording transcript or step notes. */
  transcript?: string;
  /** A free-text note steering what to look for. */
  note?: string;
  endpoints: MultimodalEndpoint[];
}

export interface DetectedFlow { name: string; steps: string[] }
export interface DetectedField { name: string; constraint: string }

export interface MultimodalResult {
  observations: string[];
  flows: DetectedFlow[];
  fields: DetectedField[];
  /** Catalogue endpoint URLs the inputs appear to exercise (verbatim). */
  mappedEndpoints: string[];
  brief: NlBrief;
}

const LAYERS = ['smoke', 'contract', 'schema', 'negative', 'auth', 'security', 'performance', 'flow'];
const COVERAGE = ['essential', 'standard', 'exhaustive'];
const ALLOWED_MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGES = 6;
/** ~4.6 MB of base64 ≈ 3.5 MB binary — the Messages API per-image ceiling. */
const MAX_IMAGE_B64 = 4_600_000;

function endpointLines(endpoints: MultimodalEndpoint[]): string {
  return endpoints.slice(0, 80).map((e) => `- ${(e.method || 'GET').toUpperCase()} ${e.url}${e.title ? `  (${e.title})` : ''}`).join('\n');
}

/** Validate and normalise the images: strip any data: prefix, bound count/size/type. */
export function normalizeImages(raw: MultimodalInput['images']): LlmImage[] {
  if (!Array.isArray(raw)) return [];
  const out: LlmImage[] = [];
  for (const im of raw.slice(0, MAX_IMAGES)) {
    if (!im || typeof im !== 'object') continue;
    let data = String(im.data || '');
    let mediaType = String(im.mediaType || '').toLowerCase();
    // Accept a full data URL and split out the media type + payload.
    const m = data.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) { mediaType = mediaType || (m[1] || '').toLowerCase(); data = m[2] || ''; }
    data = data.replace(/\s+/g, '');
    if (!data) continue;
    if (!ALLOWED_MEDIA.includes(mediaType)) mediaType = 'image/png';
    if (data.length > MAX_IMAGE_B64) throw new Error('One of the images is too large — keep each under ~3MB.');
    out.push({ data, mediaType });
  }
  return out;
}

export async function analyzeMultimodal(input: MultimodalInput, llm: LlmConfig): Promise<MultimodalResult> {
  if (!llm) throw new Error('Multimodal analysis needs an LLM — configure an Anthropic model under System Configuration → LLM, or an API-automation LLM provider.');
  const images = normalizeImages(input.images);
  const figma = String(input.figma || '').slice(0, 12000).trim();
  const transcript = String(input.transcript || '').slice(0, 12000).trim();
  const note = String(input.note || '').slice(0, 800).trim();
  const endpoints = Array.isArray(input.endpoints) ? input.endpoints : [];
  if (!images.length && !figma && !transcript) throw new Error('Add at least one input — an image, a Figma export, or a transcript.');

  const textParts = [
    `You are a senior SDET deriving an API test plan from design and product artifacts. ${images.length ? `There ${images.length === 1 ? 'is 1 image' : `are ${images.length} images`} attached (screenshots, mockups or diagrams). ` : ''}Infer the user-facing flows and the API behaviour they imply, then map to the endpoint catalogue. Respond with STRICT JSON only, no prose:`,
    `{"observations": [ "<=8 concrete things you see that matter for testing, e.g. 'a login form with email + password', 'a required quantity field'>" ],
 "flows": [ { "name": "<short flow name>", "steps": [ "<the API-level steps a user triggers>" ] } ],
 "fields": [ { "name": "<input/field name>", "constraint": "<validation implied, e.g. 'required, email format'>" } ],
 "mappedEndpoints": [ "<catalogue endpoint URLs these artifacts exercise — VERBATIM from the list, [] if unclear>" ],
 "requirements": "<one focused paragraph (<=600 chars) a test generator can act on>",
 "coverage": one of ${JSON.stringify(COVERAGE)},
 "layers": array (subset of ${JSON.stringify(LAYERS)}) implied by what you see }`,
    'Only reference endpoint URLs that appear in the catalogue — never invent one. Include "negative"/"auth"/"flow" layers where the artifacts imply validation, permissions or multi-step journeys.',
    note ? `WHAT TO LOOK FOR:\n${note}` : '',
    figma ? `FIGMA / DESIGN TEXT:\n${figma}` : '',
    transcript ? `TRANSCRIPT / STEP NOTES:\n${transcript}` : '',
    `ENDPOINT CATALOGUE:\n${endpointLines(endpoints) || '(none provided)'}`,
    'Return the JSON now.',
  ].filter(Boolean);

  const res = await runLLM(textParts.join('\n\n'), { maxTokens: 2600, llm, images: images.length ? images : undefined });
  let parsed: Record<string, any> = {};
  try { parsed = parseJsonFromResponse<Record<string, any>>(res) || {}; } catch { throw new Error('The model did not return a usable plan from the inputs.'); }

  const known = new Set(endpoints.map((e) => e.url));
  const observations = Array.isArray(parsed.observations) ? parsed.observations.map((o: any) => String(o).slice(0, 200)).slice(0, 8) : [];
  const flows: DetectedFlow[] = Array.isArray(parsed.flows)
    ? parsed.flows.slice(0, 8).map((f: any) => ({ name: String(f?.name || '').slice(0, 120), steps: Array.isArray(f?.steps) ? f.steps.map((s: any) => String(s).slice(0, 160)).slice(0, 10) : [] })).filter((f: DetectedFlow) => f.name)
    : [];
  const fields: DetectedField[] = Array.isArray(parsed.fields)
    ? parsed.fields.slice(0, 20).map((f: any) => ({ name: String(f?.name || '').slice(0, 80), constraint: String(f?.constraint || '').slice(0, 160) })).filter((f: DetectedField) => f.name)
    : [];
  const mappedEndpoints = Array.isArray(parsed.mappedEndpoints) ? [...new Set(parsed.mappedEndpoints.map(String).filter((u: string) => known.has(u)))].slice(0, 8) : [];

  const coverage = (COVERAGE.includes(String(parsed.coverage)) ? parsed.coverage : 'standard') as NlBrief['coverage'];
  let layers = Array.isArray(parsed.layers) ? [...new Set(parsed.layers.map(String).filter((l: string) => LAYERS.includes(l)))] : [];
  if (flows.length > 1) layers.push('flow');
  if (fields.length) layers.push('negative');
  layers = [...new Set(layers)];

  const brief: NlBrief = {
    requirements: String(parsed.requirements || note || 'Tests derived from design/product artifacts.').slice(0, 600),
    coverage,
    layers: layers.length ? layers : ['smoke'],
    focus: mappedEndpoints,
    outline: flows.flatMap((f) => f.steps).slice(0, 8),
  };

  return { observations, flows, fields, mappedEndpoints, brief };
}
