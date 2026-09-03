// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // The legacy single-file app is deliberately outside the linter. It is ES5-era browser script
    // in one 17k-line file with its own conventions, and it keeps shipping unchanged while the
    // Nuxt app is built up beside it (see docs/dev/adr/0002-strangler-migration.md). Linting it
    // would produce thousands of findings nobody intends to act on.
    ignores: [
      'index.html',
      'docs/**',
      '**/dist/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/node_modules/**',
      'vendor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Every boundary that leaves the type system — a directory record off the wire, a legacy
      // JSON file, a Yjs value — is parsed with Zod before it is trusted, so `any` should never
      // be the way data gets in.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // `**/scripts/**` rather than `scripts/**`: a flat-config pattern is matched from the
    // repository root, so the un-prefixed form silently covers only the top-level directory and
    // leaves a package's own scripts linted as if they were browser code.
    files: ['**/*.test.ts', '**/*.spec.ts', '**/scripts/**'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Build and maintenance scripts are plain Node ESM, so they get the Node globals the
    // browser-leaning default config does not define.
    files: ['**/scripts/**', '**/*.config.{js,ts,mjs}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly', fetch: 'readonly' },
    },
  },
);
