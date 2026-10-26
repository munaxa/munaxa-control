import base from '@munaxa/config-eslint/next.js';

/**
 * The portal owns screens, not components: every button, card, table and form control comes from
 * `@munaxa/ui`. A second one written here is the duplication the platform exists to prevent.
 */
export default [
  {
    ignores: [
      '.next/**',
      'next-env.d.ts',
      'vitest.config.ts',
      'postcss.config.mjs',
      'next.config.mjs',
    ],
  },
  ...base,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@munaxa/platform', '@munaxa/platform/*'],
              message: 'Import from @munaxa/ui, not from the implementation package behind it.',
            },
          ],
        },
      ],
    },
  },
];
