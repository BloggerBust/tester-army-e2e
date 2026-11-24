/**
 * Validates a CTRF document against the CTRF 0.3.0 schema vendored in
 * `tests/fixtures/ctrf/` (ctrf-io/ctrf at tag v0.3.0, MIT, license beside it),
 * plus the rules on `retries` and `retryAttempts` the spec states and the
 * schema cannot: `retries` equals the number of earlier attempts, which are
 * numbered from 1. Stricter than the spec, which allows `retries: 0`: e2e
 * leaves both fields out when there are none.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

const SCHEMA_PATH = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'fixtures', 'ctrf', 'ctrf-0.3.0.schema.json');

let validator: ValidateFunction | undefined;

interface CtrfTestShape {
  name: string;
  retries?: number;
  retryAttempts?: { attempt: number }[];
}

/** Asserts the document is schema-valid CTRF 0.3.0 that keeps the retry rules; throws with details otherwise. */
export function assertValidCtrf(document: unknown): void {
  if (validator === undefined) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats.default(ajv);
    validator = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>);
  }
  if (!validator(document)) {
    assert.fail(`CTRF schema violation:\n${JSON.stringify(validator.errors, null, 2)}`);
  }
  for (const test of (document as { results: { tests: CtrfTestShape[] } }).results.tests) {
    const attempts = test.retryAttempts;
    if (test.retries === 0) assert.fail(`${test.name}: retries 0 is written; e2e leaves both retry fields out when there are none`);
    if (test.retries === undefined) {
      if (attempts !== undefined) assert.fail(`${test.name}: retryAttempts without retries`);
      continue;
    }
    if (attempts === undefined || attempts.length !== test.retries) assert.fail(`${test.name}: retries ${test.retries} but ${attempts?.length ?? 0} retryAttempts`);
    attempts.forEach((attempt, index) => {
      if (attempt.attempt !== index + 1) assert.fail(`${test.name}: retry attempt ${index} is numbered ${attempt.attempt}`);
    });
  }
}
