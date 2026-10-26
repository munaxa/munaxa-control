import nest from '@munaxa/config-eslint/nest.js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ['dist/**', 'coverage/**', 'vitest.config.ts'] },
  ...nest,
  {
    /**
     * Tests only. A supertest response body is untyped JSON (`any`) by definition — it is the wire,
     * and the assertions on it are what check its shape. Typing every body would restate the
     * contract the test exists to verify. Application code keeps every one of these rules.
     */
    files: ['src/**/*.spec.ts', 'src/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
];
