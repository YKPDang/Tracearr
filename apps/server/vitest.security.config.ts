/**
 * Security Tests Configuration
 *
 * Authentication and authorization tests:
 * - Token validation and bypass attempts
 * - Privilege escalation prevention
 * - Injection attack prevention
 * - Role-based access control
 *
 * These tests verify security behavior, not implementation coverage.
 * No coverage thresholds - security tests are pass/fail.
 *
 * Run: pnpm test:security
 */

import { defineConfig, mergeConfig } from 'vitest/config';
import { sharedConfig } from './vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      name: 'security',
      include: ['src/**/*.security.test.ts'],
      // No coverage for security tests - they test behavior, not implementation
    },
  })
);
