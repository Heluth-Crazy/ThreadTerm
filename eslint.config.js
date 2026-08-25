import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '.cache/**',
      'dist/**',
      'mobile-app/dist/**',
      'src-tauri/**',
      'e2e-artifacts/**',
      'node_modules/**',
      'release/**',
    ],
  },
  ...tseslint.config({
    files: ['src/**/*.{js,jsx,ts,tsx}', 'mobile-app/src/**/*.{ts,tsx}', '*.config.{js,ts}'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  }),
];
