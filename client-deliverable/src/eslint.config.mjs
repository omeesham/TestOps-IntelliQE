// Flat ESLint config — TypeScript + Playwright rules.
//
// Enforces the governance standards the framework claims:
//  - playwright/no-focused-test: no `.only` left in (would silently skip the suite)
//  - @typescript-eslint/no-explicit-any: keep page objects/fixtures type-safe
//  - @typescript-eslint/no-unused-vars: no dead imports/vars
// `.skip` is intentionally allowed — app-specific example specs ship skipped as
// templates. To additionally enforce no-floating-promises, enable type-aware
// linting (typescript-eslint `recommendedTypeChecked` + `projectService`).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import playwright from 'eslint-plugin-playwright';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'reports/',
      'test-results/',
      'playwright-report/',
      'allure-results/',
      'allure-report/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    ...playwright.configs['flat/recommended'],
    files: ['tests/**/*.ts'],
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      'playwright/no-focused-test': 'error',
    },
  },
);
