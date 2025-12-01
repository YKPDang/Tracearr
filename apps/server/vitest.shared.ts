/**
 * Shared Vitest configuration
 *
 * Base settings used by all test group configs.
 * Import and merge with group-specific settings.
 */

import { resolve } from 'node:path';
import type { UserConfig } from 'vitest/config';

const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

export const sharedConfig: UserConfig = {
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
    clearMocks: true,
    restoreMocks: true,
    reporters: isCI ? ['default', 'github-actions'] : ['default'],
  },
  resolve: {
    alias: {
      '@tracearr/shared': resolve(__dirname, '../../packages/shared/src'),
    },
  },
};
