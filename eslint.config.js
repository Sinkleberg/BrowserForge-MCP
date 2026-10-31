import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', 'artifacts/**', 'tests/fixtures/**', 'apps/firefox-extension/build.mjs', 'scripts/**', 'apps/firefox-extension/static/**', 'release/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  // Plugins and examples are plain Node ES modules (no build step), so they get the Node globals TypeScript files get from types.
  { files: ['plugins/**/*.js', 'examples/**/*.js'], languageOptions: { globals: { URL: 'readonly', structuredClone: 'readonly', console: 'readonly', process: 'readonly', setTimeout: 'readonly', Buffer: 'readonly' } } },
  { files: ['tests/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-useless-assignment': 'off' } },
);
