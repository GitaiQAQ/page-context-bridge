/**
 * ESLint 9 Flat Config - Base quality gate
 *
 * Design principles:
 * - Concise rules, focusing only on real code quality issues
 * - Uses flat config format (ESLint 9 standard)
 */
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierCompat from 'eslint-config-prettier';

export default [
  // Ignore build artifacts, IDE history, third-party code, build scripts
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.history/**',
      '**/vendor/**',
      '**/*.config.ts',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/scripts/**',
    ],
  },

  // Match all source files
  {
    files: ['**/*.{ts,tsx,js,cjs,mjs}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        // Do not enable project: many files in monorepo are not in a unified tsconfig,
        // enabling it would cause dist/scripts/vendor and other files to report Parsing errors.
      },
      globals: {
        // Browser extension environment
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        chrome: 'readonly',
        browser: 'readonly',
        // Node.js toolchain
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        Buffer: 'readonly',
        globalThis: 'readonly',
      },
    },

    plugins: {
      '@typescript-eslint': tseslint,
    },

    rules: {
      // ---------- TypeScript: relaxed policy for rapid iteration ----------
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-require-imports': 'off',

      // ---------- General code quality ----------
      'no-console': 'off',
      'no-constant-condition': 'warn',
    },
  },

  // Prettier compatibility layer: disable all formatting rules that conflict with Prettier
  prettierCompat,
];
