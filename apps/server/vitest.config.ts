/**
 * Main Vitest Configuration
 *
 * Runs ALL tests when using `pnpm test` or `pnpm test:coverage`.
 * For targeted test runs, use the group-specific configs:
 *
 *   pnpm test:unit      - Pure functions (utils, parsers, schemas)
 *   pnpm test:services  - Business logic (services, jobs)
 *   pnpm test:routes    - API endpoints (routes with mocked DB)
 *   pnpm test:security  - Auth/authz behavior tests
 *
 * Integration tests use a separate config:
 *   pnpm test:integration - Real DB tests (vitest.integration.config.ts)
 */

import { defineConfig, mergeConfig } from 'vitest/config';
import { sharedConfig } from './vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      // Run all unit + security tests (excludes integration)
      include: ['src/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
        reportsDirectory: './coverage',
        include: [
          'src/services/**/*.ts',
          'src/routes/**/*.ts',
          'src/jobs/**/*.ts',
          'src/utils/**/*.ts',
        ],
        exclude: ['**/*.test.ts', '**/test/**'],
        // Global thresholds - intentionally low to allow incremental improvement
        thresholds: {
          statements: 10,
          branches: 10,
          functions: 15,
          lines: 10,
          // Per-file thresholds for well-tested modules
          'services/rules.ts': {
            statements: 95,
            branches: 90,
            functions: 95,
            lines: 95,
          },
          'routes/rules.ts': {
            statements: 90,
            branches: 80,
            functions: 95,
            lines: 90,
          },
          'routes/violations.ts': {
            statements: 90,
            branches: 80,
            functions: 95,
            lines: 90,
          },
        },
      },
    },
  })
);
