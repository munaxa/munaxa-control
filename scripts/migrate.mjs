#!/usr/bin/env node
// Migrates the control-plane database as the schema owner, then applies the runtime grants.
// DATABASE_MIGRATION_URL is the owner; the running service never holds it.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL (the schema owner) is not set.');
  process.exit(1);
}
// The Prisma CLI by its own path, not through `pnpm exec`: the migrate image carries no package
// manager (Dockerfile; pnpm 10.33.0 had HIGH advisories in the 20 Nov 2026 image scan), and the
// command is the one `pnpm --filter @control/api exec` resolved to, run from the same directory.
const api = resolve(root, 'apps/api');
execFileSync(
  resolve(api, 'node_modules/.bin/prisma'),
  ['migrate', 'deploy', '--schema', '../../prisma/schema.prisma'],
  { cwd: api, stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
);
execFileSync('node', [resolve(root, 'scripts/apply-grants.mjs')], { stdio: 'inherit' });
