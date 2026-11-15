import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextVitals from 'eslint-config-next/core-web-vitals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['**/dist/**', '**/.next/**', '**/next-env.d.ts', '**/.venv/**', '.tools/**']),
  { settings: { next: { rootDir: 'apps/web/' } } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: { curly: ['error', 'all'], 'one-var': ['error', 'never'] },
  },
  ...nextVitals.map((config) => ({ ...config, files: ['apps/web/**/*.{ts,tsx,js,mjs}'] })),
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
]);
