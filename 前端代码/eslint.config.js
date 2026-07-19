import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

const codeFiles = ['**/*.{js,cjs,mjs,jsx,ts,tsx}']
const typescriptFiles = ['**/*.{ts,tsx}']

export default tseslint.config(
  {
    name: 'coreone/generated-artifacts',
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/e2e-report/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  {
    name: 'coreone/javascript-recommended',
    files: codeFiles,
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
    },
  },
  {
    name: 'coreone/typescript-react',
    files: typescriptFiles,
    extends: [...tseslint.configs.recommended],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    name: 'coreone/browser',
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    name: 'coreone/vitest',
    files: [
      'src/**/*.{test,spec}.{js,jsx,ts,tsx}',
      'src/test/**/*.{js,jsx,ts,tsx}',
    ],
    languageOptions: {
      globals: globals.vitest,
    },
  },
  {
    name: 'coreone/node',
    files: ['*.{js,cjs,mjs,ts}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    name: 'coreone/commonjs',
    files: ['*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  {
    name: 'coreone/playwright',
    files: ['e2e/**/*.{js,ts}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
)
