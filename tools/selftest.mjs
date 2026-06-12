#!/usr/bin/env node
// Offline self-test: run every generated vector through the reference harness using
// the fetch shim (no network). This is both the generator's regression test and a
// living example of how implementers consume the vectors in CI.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFetchShim, runVector } from './harness.mjs';

const VEC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'vectors');

const index = JSON.parse(await readFile(join(VEC, 'index.json'), 'utf8'));
const vectors = await Promise.all(
  index.vectors.map(async (v) => JSON.parse(await readFile(join(VEC, v.file), 'utf8'))),
);
const fetchFn = makeFetchShim(vectors, (bodyFile) => readFile(join(VEC, bodyFile), 'utf8'));

let failures = 0;
for (const v of vectors) {
  const r = await runVector(v, { fetchFn });
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${v.id.padEnd(26)} ${v.title}`);
  if (!r.pass) {
    failures++;
    for (const d of r.details) console.log(`      ${d}`);
  }
}
console.log(`\n${vectors.length - failures}/${vectors.length} vectors pass`);
process.exit(failures > 0 ? 1 : 0);
