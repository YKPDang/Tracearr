/**
 * Session Processor
 *
 * Core processing logic for the poller:
 * - processServerSessions: Process sessions from a single server
 * - pollServers: Orchestrate polling across all servers
 * - Lifecycle management: start, stop, trigger
 */

import { eq, and, desc, isNull, gte } from 'drizzle-orm';
import { POLLING_INTERVALS, TIME_MS, type ActiveSession, type SessionState } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers, users, sessions } from '../../db/schema.js';
import { createMediaServerClient } from '../../services/mediaServer/index.js';
import { geoipService, type GeoLocation } from '../../services/geoip.js';
import { ruleEngine } from '../../services/rules.js';
import type { CacheService, PubSubService } from '../../services/cache.js';

import type { PollerConfig, ServerWithToken, ServerProcessingResult } from './types.js';
import { mapMediaSession } from './sessionMapper.js';
import { batchGetRecentUserSessions, getActiveRules } from './database.js';
import { calculatePauseAccumulation, calculateStopDuration, checkWatchCompletion } from './stateTracker.js';
import { createViolation } from './violations.js';

// ============================================================================
// Module State
// ============================================================================

let pollingInterval: NodeJS.Timeout | null = null;
let cacheService: CacheService | null = null;
let pubSubService: PubSubService | null = null;

const defaultConfig: PollerConfig = {
  enabled: true,
  intervalMs: POLLING_INTERVALS.SESSIONS,
};

// ============================================================================
// Server Session Processing
// ============================================================================

/**
 * Process a single server's sessions
 *
 * This function:
 * 1. Fetches current sessions from the media server
 * 2. Creates/updates users as needed
 * 3. Creates new session records for new playbacks
 * 4. Updates existing sessions with state changes
 * 5. Marks stopped sessions as stopped
 * 6. Evaluates rules and creates violations
 *
 * @param server - Server to poll
 * @param activeRules - Active rules for evaluation
 * @param cachedSessionKeys - Set of currently cached session keys
 * @returns Processing results (new, updated, stopped sessions)
 */
async function processServerSessions(
  server: ServerWithToken,
  activeRules: import('@tracearr/shared').Rule[],
  cachedSessionKeys: Set<string>
): Promise<ServerProcessingResult> {
  const newSessions: ActiveSession[] = [];
  const updatedSessions: ActiveSession[] = [];
  const currentSessionKeys = new Set<string>();

  try {
    // Fetch sessions from server using unified adapter
    const client = createMediaServerClient({
      type: server.type,
      url: server.url,
      token: server.token,
    });
    const mediaSessions = await client.getSessions();
    const processedSessions = mediaSessions.map((s) => mapMediaSession(s, server.type));

    // OPTIMIZATION: Pre-load all users for this server to avoid N+1 queries
    const serverUsers = await db
      .select()
      .from(users)
      .where(eq(users.serverId, server.id));

    // Build user caches: externalId -> user and id -> user
    const userByExternalId = new Map<string, typeof serverUsers[0]>();
    const userById = new Map<string, typeof serverUsers[0]>();
    for (const user of serverUsers) {
      if (user.externalId) {
        userByExternalId.set(user.externalId, user);
      }
      userById.set(user.id, user);
    }

    // Track users that need to be created and their session indices
    const usersToCreate: { externalId: string; username: string; thumbUrl: string | null; sessionIndex: number }[] = [];

    // First pass: identify users and resolve from cache or mark for creation
    const sessionUserIds: (string | null)[] = [];

    for (let i = 0; i < processedSessions.length; i++) {
      const processed = processedSessions[i]!;
      const existingUser = userByExternalId.get(processed.externalUserId);

      if (existingUser) {
        // Check if user data needs update
        const needsUpdate =
          existingUser.username !== processed.username ||
          (processed.userThumb && existingUser.thumbUrl !== processed.userThumb);

        if (needsUpdate) {
          await db
            .update(users)
            .set({
              username: processed.username,
              thumbUrl: processed.userThumb || existingUser.thumbUrl,
              updatedAt: new Date(),
            })
            .where(eq(users.id, existingUser.id));

          // Update cache
          existingUser.username = processed.username;
          if (processed.userThumb) existingUser.thumbUrl = processed.userThumb;
        }

        sessionUserIds.push(existingUser.id);
      } else {
        // Need to create user - mark for batch creation
        usersToCreate.push({
          externalId: processed.externalUserId,
          username: processed.username,
          thumbUrl: processed.userThumb || null,
          sessionIndex: i,
        });
        sessionUserIds.push(null); // Will be filled after creation
      }
    }

    // Batch create new users
    if (usersToCreate.length > 0) {
      const newUsers = await db
        .insert(users)
        .values(usersToCreate.map(u => ({
          serverId: server.id,
          externalId: u.externalId,
          username: u.username,
          thumbUrl: u.thumbUrl,
        })))
        .returning();

      // Update sessionUserIds with newly created user IDs
      for (let i = 0; i < usersToCreate.length; i++) {
        const userToCreate = usersToCreate[i]!;
        const newUser = newUsers[i];
        if (newUser) {
          sessionUserIds[userToCreate.sessionIndex] = newUser.id;
          userById.set(newUser.id, newUser);
          userByExternalId.set(userToCreate.externalId, newUser);
        }
      }
    }

    // OPTIMIZATION: Batch load recent sessions for rule evaluation
    // Only load for users with new sessions (not cached)
    const usersWithNewSessions = new Set<string>();
    for (let i = 0; i < processedSessions.length; i++) {
      const processed = processedSessions[i]!;
      const sessionKey = `${server.id}:${processed.sessionKey}`;
      const isNew = !cachedSessionKeys.has(sessionKey);
      const userId = sessionUserIds[i];
      if (isNew && userId) {
        usersWithNewSessions.add(userId);
      }
    }

    const recentSessionsMap = await batchGetRecentUserSessions([...usersWithNewSessions]);

    // Process each session
    for (let i = 0; i < processedSessions.length; i++) {
      const processed = processedSessions[i]!;
      const sessionKey = `${server.id}:${processed.sessionKey}`;
      currentSessionKeys.add(sessionKey);

      const userId = sessionUserIds[i];
      if (!userId) {
        console.error('Failed to get/create user for session');
        continue;
      }

      // Get user details from cache
      const userFromCache = userById.get(userId);
      const userDetail = userFromCache
        ? { id: userFromCache.id, username: userFromCache.username, thumbUrl: userFromCache.thumbUrl }
        : { id: userId, username: 'Unknown', thumbUrl: null };

      // Get GeoIP location
      const geo: GeoLocation = geoipService.lookup(processed.ipAddress);

      const isNew = !cachedSessionKeys.has(sessionKey);

      if (isNew) {
        // Check for session grouping - find recent unfinished session with same user+ratingKey
        let referenceId: string | null = null;
        if (processed.ratingKey) {
          const oneDayAgo = new Date(Date.now() - TIME_MS.DAY);
          const recentSameContent = await db
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.userId, userId),
                eq(sessions.ratingKey, processed.ratingKey),
                gte(sessions.stoppedAt, oneDayAgo),
                eq(sessions.watched, false) // Not fully watched
              )
            )
            .orderBy(desc(sessions.stoppedAt))
            .limit(1);

          const previousSession = recentSameContent[0];
          // If user is resuming (progress >= previous), link to the original session
          if (previousSession && processed.progressMs !== undefined) {
            const prevProgress = previousSession.progressMs || 0;
            if (processed.progressMs >= prevProgress) {
              // This is a "resume" - link to the first session in the chain
              referenceId = previousSession.referenceId || previousSession.id;
            }
          }
        }

        // Insert new session with pause tracking fields
        const insertedRows = await db
          .insert(sessions)
          .values({
            serverId: server.id,
            userId,
            sessionKey: processed.sessionKey,
            ratingKey: processed.ratingKey || null,
            state: processed.state,
            mediaType: processed.mediaType,
            mediaTitle: processed.mediaTitle,
            // Enhanced media metadata
            grandparentTitle: processed.grandparentTitle || null,
            seasonNumber: processed.seasonNumber || null,
            episodeNumber: processed.episodeNumber || null,
            year: processed.year || null,
            thumbPath: processed.thumbPath || null,
            startedAt: new Date(),
            totalDurationMs: processed.totalDurationMs || null,
            progressMs: processed.progressMs || null,
            // Pause tracking - use Jellyfin's precise timestamp if available, otherwise infer from state
            lastPausedAt: processed.lastPausedDate ?? (processed.state === 'paused' ? new Date() : null),
            pausedDurationMs: 0,
            // Session grouping
            referenceId,
            watched: false,
            // Network/device info
            ipAddress: processed.ipAddress,
            geoCity: geo.city,
            geoRegion: geo.region,
            geoCountry: geo.country,
            geoLat: geo.lat,
            geoLon: geo.lon,
            playerName: processed.playerName,
            deviceId: processed.deviceId || null,
            product: processed.product || null,
            device: processed.device || null,
            platform: processed.platform,
            quality: processed.quality,
            isTranscode: processed.isTranscode,
            bitrate: processed.bitrate,
          })
          .returning();

        const inserted = insertedRows[0];
        if (!inserted) {
          console.error('Failed to insert session');
          continue;
        }

        const activeSession: ActiveSession = {
          id: inserted.id,
          serverId: server.id,
          userId,
          sessionKey: processed.sessionKey,
          state: processed.state,
          mediaType: processed.mediaType,
          mediaTitle: processed.mediaTitle,
          // Enhanced media metadata
          grandparentTitle: processed.grandparentTitle || null,
          seasonNumber: processed.seasonNumber || null,
          episodeNumber: processed.episodeNumber || null,
          year: processed.year || null,
          thumbPath: processed.thumbPath || null,
          ratingKey: processed.ratingKey || null,
          externalSessionId: null,
          startedAt: inserted.startedAt,
          stoppedAt: null,
          durationMs: null,
          totalDurationMs: processed.totalDurationMs || null,
          progressMs: processed.progressMs || null,
          // Pause tracking
          lastPausedAt: inserted.lastPausedAt,
          pausedDurationMs: inserted.pausedDurationMs,
          referenceId: inserted.referenceId,
          watched: inserted.watched,
          // Network/device info
          ipAddress: processed.ipAddress,
          geoCity: geo.city,
          geoRegion: geo.region,
          geoCountry: geo.country,
          geoLat: geo.lat,
          geoLon: geo.lon,
          playerName: processed.playerName,
          deviceId: processed.deviceId || null,
          product: processed.product || null,
          device: processed.device || null,
          platform: processed.platform,
          quality: processed.quality,
          isTranscode: processed.isTranscode,
          bitrate: processed.bitrate,
          user: userDetail,
          server: { id: server.id, name: server.name, type: server.type },
        };

        newSessions.push(activeSession);

        // Evaluate rules for new session (using batch-loaded recent sessions)
        const recentSessions = recentSessionsMap.get(userId) ?? [];
        const session = {
          id: inserted.id,
          serverId: server.id,
          userId,
          sessionKey: processed.sessionKey,
          state: processed.state,
          mediaType: processed.mediaType,
          mediaTitle: processed.mediaTitle,
          grandparentTitle: processed.grandparentTitle || null,
          seasonNumber: processed.seasonNumber || null,
          episodeNumber: processed.episodeNumber || null,
          year: processed.year || null,
          thumbPath: processed.thumbPath || null,
          ratingKey: processed.ratingKey || null,
          externalSessionId: null,
          startedAt: inserted.startedAt,
          stoppedAt: null,
          durationMs: null,
          totalDurationMs: processed.totalDurationMs || null,
          progressMs: processed.progressMs || null,
          lastPausedAt: inserted.lastPausedAt,
          pausedDurationMs: inserted.pausedDurationMs,
          referenceId: inserted.referenceId,
          watched: inserted.watched,
          ipAddress: processed.ipAddress,
          geoCity: geo.city,
          geoRegion: geo.region,
          geoCountry: geo.country,
          geoLat: geo.lat,
          geoLon: geo.lon,
          playerName: processed.playerName,
          deviceId: processed.deviceId || null,
          product: processed.product || null,
          device: processed.device || null,
          platform: processed.platform,
          quality: processed.quality,
          isTranscode: processed.isTranscode,
          bitrate: processed.bitrate,
        };

        const ruleResults = await ruleEngine.evaluateSession(session, activeRules, recentSessions);

        // Create violations for triggered rules
        for (const result of ruleResults) {
          const matchingRule = activeRules.find(
            (r) =>
              (r.userId === null || r.userId === userId) && result.violated
          );
          if (matchingRule) {
            // createViolation handles both DB insert and WebSocket broadcast
            await createViolation(matchingRule.id, userId, inserted.id, result, matchingRule, pubSubService);
          }
        }
      } else {
        // Get existing session to check for state changes
        const existingRows = await db
          .select()
          .from(sessions)
          .where(
            and(eq(sessions.serverId, server.id), eq(sessions.sessionKey, processed.sessionKey))
          )
          .limit(1);

        const existingSession = existingRows[0];
        if (!existingSession) continue;

        const previousState = existingSession.state;
        const newState = processed.state;
        const now = new Date();

        // Build update payload with pause tracking
        const updatePayload: {
          state: 'playing' | 'paused';
          quality: string;
          bitrate: number;
          progressMs: number | null;
          lastPausedAt?: Date | null;
          pausedDurationMs?: number;
          watched?: boolean;
        } = {
          state: newState,
          quality: processed.quality,
          bitrate: processed.bitrate,
          progressMs: processed.progressMs || null,
        };

        // Handle state transitions for pause tracking
        const pauseResult = calculatePauseAccumulation(
          previousState as SessionState,
          newState,
          { lastPausedAt: existingSession.lastPausedAt, pausedDurationMs: existingSession.pausedDurationMs || 0 },
          now
        );
        updatePayload.lastPausedAt = pauseResult.lastPausedAt;
        updatePayload.pausedDurationMs = pauseResult.pausedDurationMs;

        // Check for watch completion (80% threshold)
        if (!existingSession.watched && checkWatchCompletion(processed.progressMs, processed.totalDurationMs)) {
          updatePayload.watched = true;
        }

        // Update existing session with state changes and pause tracking
        await db
          .update(sessions)
          .set(updatePayload)
          .where(eq(sessions.id, existingSession.id));

        // Build active session for cache/broadcast (with updated pause tracking values)
        const activeSession: ActiveSession = {
          id: existingSession.id,
          serverId: server.id,
          userId,
          sessionKey: processed.sessionKey,
          state: newState,
          mediaType: processed.mediaType,
          mediaTitle: processed.mediaTitle,
          // Enhanced media metadata
          grandparentTitle: processed.grandparentTitle || null,
          seasonNumber: processed.seasonNumber || null,
          episodeNumber: processed.episodeNumber || null,
          year: processed.year || null,
          thumbPath: processed.thumbPath || null,
          ratingKey: processed.ratingKey || null,
          externalSessionId: existingSession.externalSessionId,
          startedAt: existingSession.startedAt,
          stoppedAt: null,
          durationMs: null,
          totalDurationMs: processed.totalDurationMs || null,
          progressMs: processed.progressMs || null,
          // Pause tracking - use updated values
          lastPausedAt: updatePayload.lastPausedAt ?? existingSession.lastPausedAt,
          pausedDurationMs: updatePayload.pausedDurationMs ?? existingSession.pausedDurationMs ?? 0,
          referenceId: existingSession.referenceId,
          watched: updatePayload.watched ?? existingSession.watched ?? false,
          // Network/device info
          ipAddress: processed.ipAddress,
          geoCity: geo.city,
          geoRegion: geo.region,
          geoCountry: geo.country,
          geoLat: geo.lat,
          geoLon: geo.lon,
          playerName: processed.playerName,
          deviceId: processed.deviceId || null,
          product: processed.product || null,
          device: processed.device || null,
          platform: processed.platform,
          quality: processed.quality,
          isTranscode: processed.isTranscode,
          bitrate: processed.bitrate,
          user: userDetail,
          server: { id: server.id, name: server.name, type: server.type },
        };
        updatedSessions.push(activeSession);
      }
    }

    // Find stopped sessions
    const stoppedSessionKeys: string[] = [];
    for (const cachedKey of cachedSessionKeys) {
      if (cachedKey.startsWith(`${server.id}:`) && !currentSessionKeys.has(cachedKey)) {
        stoppedSessionKeys.push(cachedKey);

        // Mark session as stopped in database
        const sessionKey = cachedKey.replace(`${server.id}:`, '');
        const stoppedRows = await db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.serverId, server.id),
              eq(sessions.sessionKey, sessionKey),
              isNull(sessions.stoppedAt)
            )
          )
          .limit(1);

        const stoppedSession = stoppedRows[0];
        if (stoppedSession) {
          const stoppedAt = new Date();

          // Calculate final duration
          const { durationMs, finalPausedDurationMs } = calculateStopDuration(
            {
              startedAt: stoppedSession.startedAt,
              lastPausedAt: stoppedSession.lastPausedAt,
              pausedDurationMs: stoppedSession.pausedDurationMs || 0,
            },
            stoppedAt
          );

          // Check for watch completion
          const watched = stoppedSession.watched || checkWatchCompletion(
            stoppedSession.progressMs,
            stoppedSession.totalDurationMs
          );

          await db
            .update(sessions)
            .set({
              state: 'stopped',
              stoppedAt,
              durationMs,
              pausedDurationMs: finalPausedDurationMs,
              lastPausedAt: null, // Clear the pause timestamp
              watched,
            })
            .where(eq(sessions.id, stoppedSession.id));
        }
      }
    }

    return { newSessions, stoppedSessionKeys, updatedSessions };
  } catch (error) {
    console.error(`Error polling server ${server.name}:`, error);
    return { newSessions: [], stoppedSessionKeys: [], updatedSessions: [] };
  }
}

// ============================================================================
// Main Polling Orchestration
// ============================================================================

/**
 * Poll all connected servers for active sessions
 */
async function pollServers(): Promise<void> {
  try {
    // Get all connected servers
    const allServers = await db.select().from(servers);

    if (allServers.length === 0) {
      return;
    }

    // Get cached session keys
    const cachedSessions = cacheService ? await cacheService.getActiveSessions() : null;
    const cachedSessionKeys = new Set(
      (cachedSessions ?? []).map((s) => `${s.serverId}:${s.sessionKey}`)
    );

    // Get active rules
    const activeRules = await getActiveRules();

    // Collect results from all servers
    const allNewSessions: ActiveSession[] = [];
    const allStoppedKeys: string[] = [];
    const allUpdatedSessions: ActiveSession[] = [];

    // Process each server
    for (const server of allServers) {
      const serverWithToken = server as ServerWithToken;
      const { newSessions, stoppedSessionKeys, updatedSessions } = await processServerSessions(
        serverWithToken,
        activeRules,
        cachedSessionKeys
      );

      allNewSessions.push(...newSessions);
      allStoppedKeys.push(...stoppedSessionKeys);
      allUpdatedSessions.push(...updatedSessions);
    }

    // Update cache with current active sessions
    if (cacheService) {
      const currentActiveSessions = [...allNewSessions, ...allUpdatedSessions];
      await cacheService.setActiveSessions(currentActiveSessions);

      // Update individual session cache
      for (const session of allNewSessions) {
        await cacheService.setSessionById(session.id, session);
        await cacheService.addUserSession(session.userId, session.id);
      }

      for (const session of allUpdatedSessions) {
        await cacheService.setSessionById(session.id, session);
      }

      // Remove stopped sessions from cache
      for (const key of allStoppedKeys) {
        const parts = key.split(':');
        if (parts.length >= 2) {
          const serverId = parts[0];
          const sessionKey = parts.slice(1).join(':');

          // Find the session to get its ID
          const stoppedSession = cachedSessions?.find(
            (s) => s.serverId === serverId && s.sessionKey === sessionKey
          );
          if (stoppedSession) {
            await cacheService.deleteSessionById(stoppedSession.id);
            await cacheService.removeUserSession(stoppedSession.userId, stoppedSession.id);
          }
        }
      }
    }

    // Publish events via pub/sub
    if (pubSubService) {
      for (const session of allNewSessions) {
        await pubSubService.publish('session:started', session);
      }

      for (const session of allUpdatedSessions) {
        await pubSubService.publish('session:updated', session);
      }

      for (const key of allStoppedKeys) {
        const parts = key.split(':');
        if (parts.length >= 2) {
          const serverId = parts[0];
          const sessionKey = parts.slice(1).join(':');
          const stoppedSession = cachedSessions?.find(
            (s) => s.serverId === serverId && s.sessionKey === sessionKey
          );
          if (stoppedSession) {
            await pubSubService.publish('session:stopped', stoppedSession.id);
          }
        }
      }
    }

    if (allNewSessions.length > 0 || allStoppedKeys.length > 0) {
      console.log(
        `Poll complete: ${allNewSessions.length} new, ${allUpdatedSessions.length} updated, ${allStoppedKeys.length} stopped`
      );
    }
  } catch (error) {
    console.error('Polling error:', error);
  }
}

// ============================================================================
// Lifecycle Management
// ============================================================================

/**
 * Initialize the poller with cache services
 */
export function initializePoller(cache: CacheService, pubSub: PubSubService): void {
  cacheService = cache;
  pubSubService = pubSub;
}

/**
 * Start the polling job
 */
export function startPoller(config: Partial<PollerConfig> = {}): void {
  const mergedConfig = { ...defaultConfig, ...config };

  if (!mergedConfig.enabled) {
    console.log('Session poller disabled');
    return;
  }

  if (pollingInterval) {
    console.log('Poller already running');
    return;
  }

  console.log(`Starting session poller with ${mergedConfig.intervalMs}ms interval`);

  // Run immediately on start
  void pollServers();

  // Then run on interval
  pollingInterval = setInterval(() => void pollServers(), mergedConfig.intervalMs);
}

/**
 * Stop the polling job
 */
export function stopPoller(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('Session poller stopped');
  }
}

/**
 * Force an immediate poll
 */
export async function triggerPoll(): Promise<void> {
  await pollServers();
}
