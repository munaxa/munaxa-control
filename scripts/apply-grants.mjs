#!/usr/bin/env node
// Applies infra/sql/grants.sql as the schema owner, after `prisma migrate deploy`.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL (the schema owner) is not set.');
  process.exit(1);
}
execFileSync(
  'psql',
  [url, '-v', 'ON_ERROR_STOP=1', '-q', '-f', join(root, 'infra/sql/grants.sql')],
  {
    stdio: 'inherit',
  },
);
console.log('grants applied');
