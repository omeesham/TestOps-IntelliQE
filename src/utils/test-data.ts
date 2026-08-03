/**
 * Minimal test-data loader.
 * Reads a JSON file from `../data/<name>.json` relative to this module.
 * Keep all test data in `src/data/` — never hardcode sensitive values.
 */
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.resolve(__dirname, '..', 'data');

export function loadData<T = unknown>(name: string): T {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Test data file not found: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}
