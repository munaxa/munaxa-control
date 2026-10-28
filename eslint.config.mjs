import root from '@munaxa/config-eslint/root.js';

/** A fast, non-type-checked sweep. Each app's own type-aware config takes precedence under turbo. */
export default [
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/coverage/**', '**/.turbo/**'],
  },
  ...root,
];
