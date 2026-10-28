#!/usr/bin/env node
// Emits the control plane's permission catalogue as JSON, for Munaxa Identity to seed roles from —
// the same arrangement Identity has with Munaxa Work (its artifacts/README.md). The source of truth
// is apps/api/src/auth/permissions.ts; this reads it rather than restating it.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'apps/api/src/auth/permissions.ts'), 'utf8');
const grants = [...source.matchAll(/'(control:[a-z]+:[a-z]+)'/g)].map((m) => m[1]);
if (grants.length === 0) {
  console.error('no control: grants found');
  process.exit(1);
}
process.stdout.write(`${JSON.stringify([...new Set(grants)].sort(), null, 2)}\n`);
