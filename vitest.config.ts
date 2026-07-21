import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['test/**', '**/*.int.test.ts'],
    setupFiles: ['test/unit/setup-env.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/domain/**',
        'src/application/**',
        'src/presentation/http/guards/**',
        'src/presentation/http/plugins/**',
        'src/presentation/http/error-handler.ts',
      ],
      exclude: ['src/application/shared/ports/**'],
      reporter: ['text', 'text-summary', 'html'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
