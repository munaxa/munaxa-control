#!/usr/bin/env node
// Applies infra/sql/grants.sql as the schema owner, after `prisma migrate deploy`.
// The URL is passed as an argument to a child process and never printed.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL (the schema owner) is not set.');
  process.exit(1);
}
// Through Prisma's own executor rather than psql: the release image carries the Prisma CLI and no
// PostgreSQL client, and the file is plain SQL that one transaction applies or refuses as a whole.
execFileSync(
  'pnpm',
  [
    '--filter',
    '@control/api',
    'exec',
    'prisma',
    'db',
    'execute',
    '--url',
    url,
    '--file',
    join(root, 'infra/sql/grants.sql'),
  ],
  { cwd: root, stdio: 'inherit' },
);
console.log('grants applied');
