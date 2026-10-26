/**
 * skills
 * ──────
 * Skills are short expert checklists in backend/config/skills, loaded into the
 * agents' system prompt. They can be improved without code changes.
 *
 *   test-design        core: coverage model, techniques, categories, levels (always)
 *   forms-validation   picked when the app has data-entry fields
 *   file-upload        picked when the app has a file input
 *   login-auth         picked when the app has a sign-in (login screen or sign-in text)
 *   document-verification  picked when the app reads documents (scan/OCR screen, or such requirements)
 *
 * Only the skills that match what the application has are loaded, so prompts
 * stay small.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { TestOpsState } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/agents and dist/agents both resolve to backend/config/skills.
const SKILLS_DIR = process.env.SKILLS_DIR || path.resolve(__dirname, '..', '..', 'config', 'skills');

export type SkillName = 'test-design' | 'forms-validation' | 'file-upload' | 'login-auth' | 'document-verification';

const cache = new Map<SkillName, string>();

/** The skill's text, or '' when the file is missing (agents still work without it). */
export function loadSkill(name: SkillName): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let text = '';
  try {
    text = fs.readFileSync(path.join(SKILLS_DIR, `${name}.md`), 'utf8').trim();
  } catch (e) {
    console.warn(`[skills] ${name} not found in ${SKILLS_DIR}: ${(e as Error).message}`);
  }
  cache.set(name, text);
  return text;
}

/**
 * Feature skills that match the application, from the explored pages and the
 * requirement text. The core test-design skill is always included.
 */
export function selectSkills(state: Pick<TestOpsState, 'exploredApp' | 'requirements'>): SkillName[] {
  const pages = state.exploredApp?.pages || [];
  const fields = pages.flatMap((p) => (p.forms || []).flatMap((f) => f.fields || []));
  const fieldText = fields.map((f) => `${f.label || f.name} type=${f.type}`).join('\n');
  const text = `${state.requirements || ''}\n${fieldText}`.toLowerCase();

  const picked: SkillName[] = ['test-design'];
  const hasEntryFields = fields.length > 0 || /\b(required|max(imum)? \d+|min(imum)? \d+|characters|digits|format)\b/.test(text);
  if (hasEntryFields) picked.push('forms-validation');
  if (/type=file|\bfile\b.*\b(upload|attach)|\bupload\b/.test(text)) picked.push('file-upload');
  // Explored: decide from the screens Explore recognised. Pasted requirements:
  // extraction wording together with a document.
  const readsDocuments = state.exploredApp
    ? (state.exploredApp.documentFeatures?.length ?? 0) > 0
    : /\b(ocr|extract(s|ed|ion)?|scann(ed|ing)|confidence score)\b/.test(text)
      && /\b(pdf|document|ticket|invoice|receipt|timesheet|form|image)s?\b/.test(text);
  if (readsDocuments) picked.push('document-verification');
  // A password field alone (e.g. on a registration form) is not a sign-in. When
  // the app was explored, decide from the pages: the synthesized requirement
  // text may mention sign-in only to say it is not needed.
  const signInPage = pages.some((p) =>
    /\b(sign[ -]?in|log[ -]?in|login)\b/i.test(`${p.title} ${p.headings.join(' ')}`)
    && (p.forms || []).some((f) => f.fields.some((fd) => fd.type === 'password')));
  const hasSignIn = state.exploredApp
    ? state.exploredApp.authDetected || signInPage
    : /\b(sign[ -]?in|log[ -]?in|login)\b/.test(text);
  if (hasSignIn) picked.push('login-auth');
  return picked;
}

/** System prompt for an agent: its role line, then the skills it should follow. */
export function skillSystemPrompt(role: string, names: SkillName[] = ['test-design']): string {
  const skills = names.map(loadSkill).filter(Boolean);
  if (!skills.length) return role;
  return `${role}\n\nFollow ${skills.length > 1 ? 'these skills' : 'this skill'}:\n\n${skills.join('\n\n---\n\n')}`;
}
