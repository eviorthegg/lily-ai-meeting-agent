// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.aws-sam/**',
      '**/coverage/**',
      'web/dist/**',
      // Local-stage scratch: generated mail and throwaway drivers for poking at
      // the running API by hand. Gitignored, and not code this project ships.
      'tmp/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build and codegen scripts run under Node, not in a browser, so the base
    // config's assumption that `console`/`process` are undefined is wrong here.
    files: ['**/scripts/**/*.{mjs,js}', '*.config.{js,mjs,ts}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // The data policy is load-bearing, not advisory. These names must never
      // appear as persisted fields — see docs/data-policy.md and the runtime
      // guard in @lily/shared. Lint catches the accident at author time; the
      // runtime guard catches anything that gets past it.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Property[key.name=/^(transcript|transcripts|audioData|videoData|recordingUrl|fileContents|sourceCode|agentOutput)$/]",
          message:
            'Data policy: transcripts, media, source code and raw agent output are never persisted. ' +
            'If this is transient in-memory state, name it explicitly (e.g. transientTranscriptWindow).',
        },
      ],
    },
  },
  {
    // MUST stay last: flat config resolves later entries over earlier ones, so
    // this has to follow the block that turns the rule on.
    //
    // The data-policy rule catches a forbidden field name being introduced in
    // production code. Tests and verification scripts must be able to WRITE
    // those names — asserting that `{ transcript: ... }` is rejected is the
    // entire point of them. The runtime guard in api/src/db/data-policy.ts is
    // what actually protects the database; the lint rule is an author-time hint.
    files: ['**/*.test.ts', '**/*.test.mts', 'scripts/db-verify.mjs'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
