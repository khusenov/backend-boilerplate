import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import vitest from '@vitest/eslint-plugin';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', '.claude'] },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            'tsup.config.ts',
            'prisma.config.ts',
            'vitest.config.ts',
            'vitest.integration.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    ignores: ['dist', 'node_modules', 'coverage', 'src/generated'],
  },
  {
    // Plain-JS tooling isn't part of the typed source graph — exempt it from type-aware rules.
    files: ['**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.test.ts', 'test/**/*.ts'],
    plugins: { vitest },
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      'vitest/unbound-method': 'error',
    },
  },
  {
    files: ['src/application/**/*.test.ts', 'test/unit/support/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression > TSAsExpression[typeAnnotation.type="TSUnknownKeyword"]',
          message:
            'Do not fabricate port doubles with `as unknown as T`. Use mock<T>() from vitest-mock-extended, or a helper from @test/unit/support.',
        },
        {
          selector: 'TSAsExpression > TSAsExpression[typeAnnotation.type="TSNeverKeyword"]',
          message:
            'Do not fabricate port doubles with `as never as T`. Use mock<T>() from vitest-mock-extended, or a helper from @test/unit/support.',
        },
      ],
    },
  },
  prettier,
);
