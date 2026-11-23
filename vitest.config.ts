import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: process.env.CI
      ? ['default', ['html', { outputFile: 'tests/_reports/index.html' }]]
      : ['default', ['html', { outputFile: 'tests/_reports/index.html' }]],
    outputFile: {
      html: 'tests/_reports/index.html',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'tests/_reports/coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/cli/**', 'src/storage/migrate.ts'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
      },
    },
    testTimeout: 30_000,
  },
});
