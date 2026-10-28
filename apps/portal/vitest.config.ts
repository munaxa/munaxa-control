import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws outside a React Server Component build; the specs run plain Node.
      'server-only': fileURLToPath(new URL('./src/testing/server-only.ts', import.meta.url)),
    },
  },
  test: { globals: true, environment: 'node', include: ['src/**/*.spec.ts'] },
});
