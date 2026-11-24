#!/usr/bin/env node
// Applies infra/sql/grants.sql as the schema owner, after `prisma migrate deploy`.
//
// The Prisma CLI by its own path, not through `pnpm exec`: the migrate image carries no package
// manager (Dockerfile). The schema owner's URL goes to the child process in its environment
// (DATABASE_URL, read by prisma/schema.prisma), never as an argument: Node prints a failed child's
// arguments (spawnargs) in its error, and on 24 Nov 2026 a `--url` argument put the owner URL into
// the task log when pnpm was missing.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL (the schema owner) is not set.');
  process.exit(1);
}
const api = resolve(root, 'apps/api');
try {
  // Through Prisma's own executor rather than psql: the release image carries the Prisma CLI and no
  // PostgreSQL client, and the file is plain SQL that one transaction applies or refuses as a whole.
  execFileSync(
    resolve(api, 'node_modules/.bin/prisma'),
    [
      'db',
      'execute',
      '--schema',
      '../../prisma/schema.prisma',
      '--file',
      join(root, 'infra/sql/grants.sql'),
    ],
    { cwd: api, stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
  );
} catch (e) {
  // A code only: the error object carries the child's environment-free arguments, but print nothing
  // from it anyway.
  console.error(`grants failed (${e && e.code ? e.code : `exit ${e && e.status}`})`);
  process.exit(1);
}
console.log('grants applied');
