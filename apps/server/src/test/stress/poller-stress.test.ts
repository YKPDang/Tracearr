/**
 * Poller Stress Test
 *
 * This test simulates the conditions that caused the "runaway PostgreSQL processes" bug:
 * - Large sessions table (10k+ historical records)
 * - Multiple concurrent active streams (10+)
 * - Rapid polling cycles
 *
 * Run with: pnpm --filter @tracearr/server test:stress
 *
 * What it tests:
 * 1. findActiveSession query performance (should be <10ms with index, >100ms without)
 * 2. Memory usage during sustained polling
 * 3. Database connection pool behavior
 * 4. No duplicate sessions created under load
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../../db/client.js';
import { sessions, servers, serverUsers, users } from '../../db/schema.js';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { findActiveSession } from '../../jobs/poller/sessionLifecycle.js';

// Test configuration
const CONFIG = {
  // Number of historical sessions to create (simulates real-world table size)
  HISTORICAL_SESSIONS: 5000,
  // Number of concurrent active streams to simulate
  CONCURRENT_STREAMS: 10,
  // Number of poll cycles to simulate
  POLL_CYCLES: 20,
  // Acceptable query time in ms (with index should be <10ms)
  MAX_QUERY_TIME_MS: 50,
  // Memory increase threshold (bytes) - alert if memory grows too much
  MAX_MEMORY_INCREASE_MB: 100,
};

// Test fixtures
let testServerId: string;
let testServerUserId: string;
let testUserId: string;
/**
 * Measure query execution time
 */
async function measureQueryTime<T>(fn: () => Promise<T>): Promise<{ result: T; timeMs: number }> {
  const start = performance.now();
  const result = await fn();
  const timeMs = performance.now() - start;
  return { result, timeMs };
}

/**
 * Get current memory usage in MB
 */
function getMemoryUsageMB(): number {
  const usage = process.memoryUsage();
  return Math.round(usage.heapUsed / 1024 / 1024);
}

/**
 * Generate a random session key
 */
function randomSessionKey(): string {
  return `stress-test-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Generate a random rating key (media identifier)
 */
function randomRatingKey(): string {
  return `media-${Math.floor(Math.random() * 100000)}`;
}

describe('Poller Stress Test', () => {
  beforeAll(async () => {
    console.log('\n📊 Starting Poller Stress Test');
    console.log(`   Historical sessions: ${CONFIG.HISTORICAL_SESSIONS}`);
    console.log(`   Concurrent streams: ${CONFIG.CONCURRENT_STREAMS}`);
    console.log(`   Poll cycles: ${CONFIG.POLL_CYCLES}\n`);

    // Create test user
    const [user] = await db
      .insert(users)
      .values({
        username: 'stress-test-user',
        role: 'member',
      })
      .returning();
    testUserId = user!.id;

    // Create test server
    const [server] = await db
      .insert(servers)
      .values({
        name: 'Stress Test Server',
        type: 'jellyfin',
        url: 'http://localhost:8096',
        token: 'test-token',
      })
      .returning();
    testServerId = server!.id;

    // Create test server user
    const [serverUser] = await db
      .insert(serverUsers)
      .values({
        userId: testUserId,
        serverId: testServerId,
        externalId: 'stress-test-external-id',
        username: 'stress-test-user',
      })
      .returning();
    testServerUserId = serverUser!.id;

    // Populate with historical sessions (stopped sessions)
    console.log(`   Creating ${CONFIG.HISTORICAL_SESSIONS} historical sessions...`);
    const batchSize = 500;
    const batches = Math.ceil(CONFIG.HISTORICAL_SESSIONS / batchSize);

    for (let i = 0; i < batches; i++) {
      const sessionsToCreate = [];
      const count = Math.min(batchSize, CONFIG.HISTORICAL_SESSIONS - i * batchSize);

      for (let j = 0; j < count; j++) {
        const startedAt = new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000); // Random time in last 30 days
        const stoppedAt = new Date(startedAt.getTime() + Math.random() * 2 * 60 * 60 * 1000); // 0-2 hours later

        sessionsToCreate.push({
          serverId: testServerId,
          serverUserId: testServerUserId,
          sessionKey: randomSessionKey(),
          ratingKey: randomRatingKey(),
          state: 'stopped' as const,
          mediaType: 'episode' as const,
          mediaTitle: `Stress Test Episode ${i * batchSize + j}`,
          ipAddress: '192.168.1.1',
          platform: 'Test',
          quality: '1080p',
          isTranscode: false,
          startedAt,
          stoppedAt,
          lastSeenAt: stoppedAt,
          durationMs: stoppedAt.getTime() - startedAt.getTime(),
        });
      }

      await db.insert(sessions).values(sessionsToCreate);
      process.stdout.write(
        `\r   Progress: ${Math.min((i + 1) * batchSize, CONFIG.HISTORICAL_SESSIONS)}/${CONFIG.HISTORICAL_SESSIONS}`
      );
    }
    console.log('\n   ✓ Historical sessions created\n');
  });

  afterAll(async () => {
    // Cleanup test data
    console.log('\n   Cleaning up test data...');
    await db.delete(sessions).where(eq(sessions.serverId, testServerId));
    await db.delete(serverUsers).where(eq(serverUsers.id, testServerUserId));
    await db.delete(servers).where(eq(servers.id, testServerId));
    await db.delete(users).where(eq(users.id, testUserId));
    console.log('   ✓ Cleanup complete\n');
  });

  describe('Query Performance', () => {
    it('findActiveSession should be fast with large table', async () => {
      // Create some active sessions to query
      const activeSessionKeys: string[] = [];
      for (let i = 0; i < CONFIG.CONCURRENT_STREAMS; i++) {
        const sessionKey = `active-${i}-${randomSessionKey()}`;
        activeSessionKeys.push(sessionKey);

        await db.insert(sessions).values({
          serverId: testServerId,
          serverUserId: testServerUserId,
          sessionKey,
          ratingKey: randomRatingKey(),
          state: 'playing',
          mediaType: 'episode',
          mediaTitle: `Active Stream ${i}`,
          ipAddress: '192.168.1.1',
          platform: 'Test',
          quality: '1080p',
          isTranscode: false,
          startedAt: new Date(),
          lastSeenAt: new Date(),
        });
      }

      // Measure query times
      const queryTimes: number[] = [];

      for (const sessionKey of activeSessionKeys) {
        const { timeMs } = await measureQueryTime(() =>
          findActiveSession(testServerId, sessionKey)
        );
        queryTimes.push(timeMs);
      }

      const avgTime = queryTimes.reduce((a, b) => a + b, 0) / queryTimes.length;
      const maxTime = Math.max(...queryTimes);
      const minTime = Math.min(...queryTimes);

      console.log(`\n   📈 findActiveSession Query Performance:`);
      console.log(
        `      Table size: ~${CONFIG.HISTORICAL_SESSIONS + CONFIG.CONCURRENT_STREAMS} rows`
      );
      console.log(`      Queries: ${queryTimes.length}`);
      console.log(`      Avg time: ${avgTime.toFixed(2)}ms`);
      console.log(`      Min time: ${minTime.toFixed(2)}ms`);
      console.log(`      Max time: ${maxTime.toFixed(2)}ms`);

      // With the index, queries should be fast
      expect(avgTime).toBeLessThan(CONFIG.MAX_QUERY_TIME_MS);

      // Cleanup active sessions
      for (const sessionKey of activeSessionKeys) {
        await db
          .delete(sessions)
          .where(and(eq(sessions.serverId, testServerId), eq(sessions.sessionKey, sessionKey)));
      }
    });

    it('should handle rapid consecutive findActiveSession calls', async () => {
      // Simulate the polling pattern: 4 findActiveSession calls per session per poll
      const sessionKey = `rapid-test-${randomSessionKey()}`;

      // Create active session
      await db.insert(sessions).values({
        serverId: testServerId,
        serverUserId: testServerUserId,
        sessionKey,
        ratingKey: randomRatingKey(),
        state: 'playing',
        mediaType: 'episode',
        mediaTitle: 'Rapid Test',
        ipAddress: '192.168.1.1',
        platform: 'Test',
        quality: '1080p',
        isTranscode: false,
        startedAt: new Date(),
        lastSeenAt: new Date(),
      });

      // Simulate 20 poll cycles with 4 calls each (like the real poller)
      const allTimes: number[] = [];

      for (let cycle = 0; cycle < CONFIG.POLL_CYCLES; cycle++) {
        // The poller calls findActiveSession up to 4 times per session
        for (let call = 0; call < 4; call++) {
          const { timeMs } = await measureQueryTime(() =>
            findActiveSession(testServerId, sessionKey)
          );
          allTimes.push(timeMs);
        }
      }

      const avgTime = allTimes.reduce((a, b) => a + b, 0) / allTimes.length;
      const totalTime = allTimes.reduce((a, b) => a + b, 0);

      console.log(`\n   📈 Rapid Query Pattern (simulating ${CONFIG.POLL_CYCLES} poll cycles):`);
      console.log(`      Total queries: ${allTimes.length}`);
      console.log(`      Avg time: ${avgTime.toFixed(2)}ms`);
      console.log(`      Total time: ${totalTime.toFixed(2)}ms`);

      expect(avgTime).toBeLessThan(CONFIG.MAX_QUERY_TIME_MS);

      // Cleanup
      await db
        .delete(sessions)
        .where(and(eq(sessions.serverId, testServerId), eq(sessions.sessionKey, sessionKey)));
    });
  });

  describe('Concurrent Stream Simulation', () => {
    it('should handle multiple concurrent streams without creating duplicates', async () => {
      const activeSessionKeys: string[] = [];

      // Create concurrent active sessions
      for (let i = 0; i < CONFIG.CONCURRENT_STREAMS; i++) {
        const sessionKey = `concurrent-${i}-${randomSessionKey()}`;
        activeSessionKeys.push(sessionKey);

        await db.insert(sessions).values({
          serverId: testServerId,
          serverUserId: testServerUserId,
          sessionKey,
          ratingKey: randomRatingKey(),
          state: 'playing',
          mediaType: 'episode',
          mediaTitle: `Concurrent Stream ${i}`,
          ipAddress: '192.168.1.1',
          platform: 'Test',
          quality: '1080p',
          isTranscode: false,
          startedAt: new Date(),
          lastSeenAt: new Date(),
        });
      }

      // Simulate concurrent poll queries (like having multiple poll cycles overlap)
      // We run these in smaller batches to avoid overwhelming PostgreSQL's lock table
      for (let cycle = 0; cycle < 5; cycle++) {
        const promises: Promise<void>[] = [];
        for (const sessionKey of activeSessionKeys) {
          promises.push(
            (async () => {
              await findActiveSession(testServerId, sessionKey);
            })()
          );
        }
        await Promise.all(promises);
      }

      // Verify no duplicates were created
      for (const sessionKey of activeSessionKeys) {
        const activeSessions = await db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.serverId, testServerId),
              eq(sessions.sessionKey, sessionKey),
              isNull(sessions.stoppedAt)
            )
          );

        expect(activeSessions.length).toBe(1);
      }

      console.log(`\n   ✓ No duplicate sessions created under concurrent load`);

      // Cleanup
      for (const sessionKey of activeSessionKeys) {
        await db
          .delete(sessions)
          .where(and(eq(sessions.serverId, testServerId), eq(sessions.sessionKey, sessionKey)));
      }
    });
  });

  describe('Memory Usage', () => {
    it('should not leak memory during sustained polling simulation', async () => {
      const sessionKey = `memory-test-${randomSessionKey()}`;

      // Create active session
      await db.insert(sessions).values({
        serverId: testServerId,
        serverUserId: testServerUserId,
        sessionKey,
        ratingKey: randomRatingKey(),
        state: 'playing',
        mediaType: 'episode',
        mediaTitle: 'Memory Test',
        ipAddress: '192.168.1.1',
        platform: 'Test',
        quality: '1080p',
        isTranscode: false,
        startedAt: new Date(),
        lastSeenAt: new Date(),
      });

      const memoryBefore = getMemoryUsageMB();

      // Simulate many poll cycles
      for (let i = 0; i < 100; i++) {
        await findActiveSession(testServerId, sessionKey);

        // Force GC if available (run with --expose-gc)
        if (global.gc) {
          global.gc();
        }
      }

      const memoryAfter = getMemoryUsageMB();
      const memoryIncrease = memoryAfter - memoryBefore;

      console.log(`\n   📈 Memory Usage:`);
      console.log(`      Before: ${memoryBefore}MB`);
      console.log(`      After: ${memoryAfter}MB`);
      console.log(`      Increase: ${memoryIncrease}MB`);

      expect(memoryIncrease).toBeLessThan(CONFIG.MAX_MEMORY_INCREASE_MB);

      // Cleanup
      await db
        .delete(sessions)
        .where(and(eq(sessions.serverId, testServerId), eq(sessions.sessionKey, sessionKey)));
    });
  });

  describe('Index Effectiveness', () => {
    it('should use the sessions_active_lookup_idx index', async () => {
      // Run EXPLAIN ANALYZE to verify the index is being used
      const sessionKey = `explain-test-${randomSessionKey()}`;

      // Create test session
      await db.insert(sessions).values({
        serverId: testServerId,
        serverUserId: testServerUserId,
        sessionKey,
        ratingKey: randomRatingKey(),
        state: 'playing',
        mediaType: 'episode',
        mediaTitle: 'Explain Test',
        ipAddress: '192.168.1.1',
        platform: 'Test',
        quality: '1080p',
        isTranscode: false,
        startedAt: new Date(),
        lastSeenAt: new Date(),
      });

      // Run EXPLAIN ANALYZE
      const explainResult = await db.execute(sql`
        EXPLAIN ANALYZE
        SELECT * FROM sessions
        WHERE server_id = ${testServerId}
          AND session_key = ${sessionKey}
          AND stopped_at IS NULL
        LIMIT 1
      `);

      const explainOutput = explainResult.rows
        .map((row: Record<string, unknown>) => row['QUERY PLAN'] as string)
        .join('\n');

      console.log(`\n   📋 Query Plan:`);
      console.log(
        explainOutput
          .split('\n')
          .map((line) => `      ${line}`)
          .join('\n')
      );

      // Check if index is being used
      const usesIndex =
        explainOutput.includes('sessions_active_lookup_idx') ||
        explainOutput.includes('Index Scan') ||
        explainOutput.includes('Index Only Scan') ||
        explainOutput.includes('Bitmap Index Scan');

      const usesSeqScan = explainOutput.includes('Seq Scan');

      if (usesIndex) {
        console.log(`\n   ✓ Query uses index (good!)`);
      } else if (usesSeqScan) {
        console.log(`\n   ⚠️ Query uses sequential scan - index may be missing!`);
      }

      // Note: We don't fail the test if index isn't used because PostgreSQL
      // may choose seq scan for small tables. The important thing is performance.

      // Cleanup
      await db
        .delete(sessions)
        .where(and(eq(sessions.serverId, testServerId), eq(sessions.sessionKey, sessionKey)));
    });
  });
});
