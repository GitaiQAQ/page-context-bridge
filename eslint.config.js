/**
 * ESLint 9 Flat Config - 基础质量门禁
 *
 * 设计原则：
 * - 规则精简，只关注真正的代码质量问题
 * - 使用 flat config 格式（ESLint 9 标准）
 */
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierCompat from 'eslint-config-prettier';

export default [
  // 忽略构建产物、IDE 历史、第三方代码、构建脚本
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

  // 匹配所有源码文件
  {
    files: ['**/*.{ts,tsx,js,cjs,mjs}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        // 不启用 project：monorepo 中大量文件不在统一 tsconfig 内，
        // 启用后会导致 dist/scripts/vendor 等文件全部报 Parsing error
      },
      globals: {
        // 浏览器扩展环境
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        chrome: 'readonly',
        browser: 'readonly',
        // Node.js 工具链
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
      // ---------- TypeScript 相关：允许快速迭代阶段的宽松策略 ----------
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-require-imports': 'off',

      // ---------- 通用代码质量 ----------
      'no-console': 'off',
      'no-constant-condition': 'warn',
    },
  },

  // Prettier 兼容层：关闭所有与 Prettier 冲突的格式规则
  prettierCompat,
];
