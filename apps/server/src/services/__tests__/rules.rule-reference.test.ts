/**
 * Rule Reference Tests
 *
 * TDD tests for Issue #67: Wrong rule matching in violation loop
 *
 * The RuleEvaluationResult should include a reference to the rule that
 * produced the result, so violations can be correctly attributed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuleEngine } from '../rules.js';
import { createMockSession, createMockRule } from '../../test/fixtures.js';

describe('RuleEngine - Rule Reference in Results', () => {
  let ruleEngine: RuleEngine;
  const serverUserId = 'user-123';

  beforeEach(() => {
    ruleEngine = new RuleEngine();
  });

  describe('RuleEvaluationResult should include rule reference', () => {
    it('should include the violated rule in the result for concurrent_streams', async () => {
      const activeSessions = [
        createMockSession({ serverUserId, state: 'playing', deviceId: 'device-1' }),
        createMockSession({ serverUserId, state: 'playing', deviceId: 'device-2' }),
      ];

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        deviceId: 'device-3',
      });

      const rule = createMockRule('concurrent_streams', {
        id: 'rule-concurrent-123',
        name: 'Max 2 Streams',
        params: { maxStreams: 2 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], activeSessions);

      expect(results).toHaveLength(1);
      expect(results[0]!.violated).toBe(true);
      // The result should include the rule that was violated
      expect(results[0]!.rule).toBeDefined();
      expect(results[0]!.rule!.id).toBe('rule-concurrent-123');
      expect(results[0]!.rule!.type).toBe('concurrent_streams');
    });

    it('should include correct rule when multiple rules trigger', async () => {
      const activeSessions = [
        createMockSession({
          serverUserId,
          state: 'playing',
          deviceId: 'device-1',
          geoLat: 35.6762, // Tokyo
          geoLon: 139.6503,
        }),
      ];

      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
        deviceId: 'device-2',
        geoLat: 40.7128, // NYC
        geoLon: -74.006,
      });

      const rules = [
        createMockRule('concurrent_streams', {
          id: 'rule-concurrent-456',
          name: 'Max 1 Stream',
          params: { maxStreams: 1 },
        }),
        createMockRule('simultaneous_locations', {
          id: 'rule-locations-789',
          name: 'No Simultaneous Locations',
          params: { minDistanceKm: 100 },
        }),
      ];

      const results = await ruleEngine.evaluateSession(currentSession, rules, activeSessions);

      // Both rules should trigger
      expect(results).toHaveLength(2);

      // Each result should reference its own rule
      const concurrentResult = results.find((r) => r.rule?.type === 'concurrent_streams');
      const locationsResult = results.find((r) => r.rule?.type === 'simultaneous_locations');

      expect(concurrentResult).toBeDefined();
      expect(concurrentResult!.rule!.id).toBe('rule-concurrent-456');

      expect(locationsResult).toBeDefined();
      expect(locationsResult!.rule!.id).toBe('rule-locations-789');
    });

    it('should include rule for geo_restriction violations', async () => {
      const currentSession = createMockSession({
        serverUserId,
        geoCountry: 'CN',
      });

      const rule = createMockRule('geo_restriction', {
        id: 'rule-geo-abc',
        name: 'Block China',
        params: { mode: 'blocklist', countries: ['CN'] },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], []);

      expect(results).toHaveLength(1);
      expect(results[0]!.rule).toBeDefined();
      expect(results[0]!.rule!.id).toBe('rule-geo-abc');
      expect(results[0]!.rule!.type).toBe('geo_restriction');
    });

    it('should include rule for impossible_travel violations', async () => {
      const previousSession = createMockSession({
        serverUserId,
        deviceId: 'device-1',
        geoLat: 40.7128, // NYC
        geoLon: -74.006,
        startedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
      });

      const currentSession = createMockSession({
        serverUserId,
        deviceId: 'device-2', // Different device!
        geoLat: 51.5074, // London
        geoLon: -0.1278,
        startedAt: new Date(),
      });

      const rule = createMockRule('impossible_travel', {
        id: 'rule-travel-xyz',
        name: 'Impossible Travel Detection',
        params: { maxSpeedKmh: 500 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], [previousSession]);

      expect(results).toHaveLength(1);
      expect(results[0]!.rule).toBeDefined();
      expect(results[0]!.rule!.id).toBe('rule-travel-xyz');
      expect(results[0]!.rule!.type).toBe('impossible_travel');
    });

    it('should include rule for device_velocity violations', async () => {
      const sessions = [
        createMockSession({ serverUserId, ipAddress: '1.1.1.1' }),
        createMockSession({ serverUserId, ipAddress: '2.2.2.2' }),
        createMockSession({ serverUserId, ipAddress: '3.3.3.3' }),
      ];

      const currentSession = createMockSession({
        serverUserId,
        ipAddress: '4.4.4.4',
      });

      const rule = createMockRule('device_velocity', {
        id: 'rule-velocity-def',
        name: 'IP Velocity Check',
        params: { maxIps: 3, windowHours: 24 },
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], sessions);

      expect(results).toHaveLength(1);
      expect(results[0]!.rule).toBeDefined();
      expect(results[0]!.rule!.id).toBe('rule-velocity-def');
      expect(results[0]!.rule!.type).toBe('device_velocity');
    });
  });

  describe('non-violated results', () => {
    it('should not include rule reference when rule does not trigger', async () => {
      const currentSession = createMockSession({
        serverUserId,
        state: 'playing',
      });

      const rule = createMockRule('concurrent_streams', {
        params: { maxStreams: 10 }, // High limit, won't trigger
      });

      const results = await ruleEngine.evaluateSession(currentSession, [rule], []);

      // No violations, empty results
      expect(results).toHaveLength(0);
    });
  });
});
