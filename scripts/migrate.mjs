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
execFileSync(
  'pnpm',
  [
    '--filter',
    '@control/api',
    'exec',
    'prisma',
    'migrate',
    'deploy',
    '--schema',
    '../../prisma/schema.prisma',
  ],
  { cwd: root, stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
);
execFileSync('node', [resolve(root, 'scripts/apply-grants.mjs')], { stdio: 'inherit' });
