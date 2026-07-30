import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `.claude/worktrees/` holds a whole checkout of this repository while an
  // agent is working in one. Left in scope, its copy of tsconfig.json gives the
  // TypeScript parser a second candidate root and every file fails to parse.
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'docs/**', '.claude/worktrees/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
