/**
 * Tautulli API integration and import service
 */

import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import type { TautulliImportProgress, TautulliImportResult } from '@tracearr/shared';
import { db } from '../db/client.js';
import { sessions, users, settings } from '../db/schema.js';
import { refreshAggregates } from '../db/timescale.js';
import { geoipService } from './geoip.js';
import type { PubSubService } from './cache.js';

const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // Base delay, will be multiplied by attempt number

// Helper for fields that can be number or empty string (Tautulli API inconsistency)
// Exported for testing
export const numberOrEmptyString = z.union([z.number(), z.literal('')]);

// Zod schemas for runtime validation of Tautulli API responses
// Based on actual API response from http://192.168.1.32:8181
// Exported for testing
export const TautulliHistoryRecordSchema = z.object({
  // IDs - can be null for active sessions
  reference_id: z.number().nullable(),
  row_id: z.number().nullable(),
  id: z.number().nullable(), // Additional ID field

  // Timestamps and durations - always numbers
  date: z.number(),
  started: z.number(),
  stopped: z.number(),
  duration: z.number(),
  play_duration: z.number(), // Actual play time
  paused_counter: z.number(),

  // User info
  user_id: z.number(),
  user: z.string(),
  friendly_name: z.string(),
  user_thumb: z.string(), // User avatar URL

  // Player/client info
  platform: z.string(),
  product: z.string(),
  player: z.string(),
  ip_address: z.string(),
  machine_id: z.string(),
  location: z.string(),

  // Boolean-like flags (0/1)
  live: z.number(),
  secure: z.number(),
  relayed: z.number(),

  // Media info
  media_type: z.string(),
  rating_key: z.number(), // Always number per actual API
  // These CAN be empty string for movies, number for episodes
  parent_rating_key: numberOrEmptyString,
  grandparent_rating_key: numberOrEmptyString,
  full_title: z.string(),
  title: z.string(),
  parent_title: z.string(),
  grandparent_title: z.string(),
  original_title: z.string(),
  // year: number for movies, empty string "" for episodes
  year: numberOrEmptyString,
  // media_index: number for episodes, empty string for movies
  media_index: numberOrEmptyString,
  parent_media_index: numberOrEmptyString,
  thumb: z.string(),
  originally_available_at: z.string(),
  guid: z.string(),

  // Playback info
  transcode_decision: z.string(),
  percent_complete: z.number(),
  watched_status: z.number(), // 0, 0.75, 1

  // Session grouping
  group_count: z.number().nullable(),
  group_ids: z.string().nullable(),
  state: z.string().nullable(),
  session_key: z.number().nullable(), // Actually just number | null per API
});

export const TautulliHistoryResponseSchema = z.object({
  response: z.object({
    result: z.string(),
    message: z.string().nullable(),
    data: z.object({
      recordsFiltered: z.number(),
      recordsTotal: z.number(),
      data: z.array(TautulliHistoryRecordSchema),
      draw: z.number(),
      filter_duration: z.string(),
      total_duration: z.string(),
    }),
  }),
});

export const TautulliUserRecordSchema = z.object({
  user_id: z.number(),
  username: z.string(),
  friendly_name: z.string(),
  email: z.string().nullable(), // Can be null for local users
  thumb: z.string().nullable(), // Can be null for local users
  is_home_user: z.number().nullable(), // Can be null for local users
  is_admin: z.number(),
  is_active: z.number(),
  do_notify: z.number(),
});

export const TautulliUsersResponseSchema = z.object({
  response: z.object({
    result: z.string(),
    message: z.string().nullable(),
    data: z.array(TautulliUserRecordSchema),
  }),
});

// Infer types from schemas - exported for testing
export type TautulliHistoryRecord = z.infer<typeof TautulliHistoryRecordSchema>;
export type TautulliHistoryResponse = z.infer<typeof TautulliHistoryResponseSchema>;
export type TautulliUserRecord = z.infer<typeof TautulliUserRecordSchema>;
export type TautulliUsersResponse = z.infer<typeof TautulliUsersResponseSchema>;

export class TautulliService {
  private baseUrl: string;
  private apiKey: string;

  constructor(url: string, apiKey: string) {
    this.baseUrl = url.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  /**
   * Make API request to Tautulli with timeout and retry logic
   */
  private async request<T>(
    cmd: string,
    params: Record<string, string | number> = {},
    schema?: z.ZodType<T>
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v2`);
    url.searchParams.set('apikey', this.apiKey);
    url.searchParams.set('cmd', cmd);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url.toString(), {
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Tautulli API error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();

        // Validate response with Zod schema if provided
        if (schema) {
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            console.error('Tautulli API response validation failed:', parsed.error.flatten());
            throw new Error(`Invalid Tautulli API response: ${parsed.error.message}`);
          }
          return parsed.data;
        }

        return json as T;
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error) {
          // Don't retry on abort (timeout) after max retries
          if (error.name === 'AbortError') {
            lastError = new Error(`Tautulli API timeout after ${REQUEST_TIMEOUT_MS}ms`);
          } else {
            lastError = error;
          }
        } else {
          lastError = new Error('Unknown error');
        }

        // Don't retry on validation errors
        if (lastError.message.includes('Invalid Tautulli API response')) {
          throw lastError;
        }

        // Wait before retrying (exponential backoff)
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * attempt;
          console.warn(`Tautulli API request failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('Tautulli API request failed after retries');
  }

  /**
   * Test connection to Tautulli
   */
  async testConnection(): Promise<boolean> {
    try {
      const result = await this.request<{ response: { result: string } }>('arnold');
      return result.response.result === 'success';
    } catch {
      return false;
    }
  }

  /**
   * Get all users from Tautulli
   */
  async getUsers(): Promise<TautulliUserRecord[]> {
    const result = await this.request<TautulliUsersResponse>(
      'get_users',
      {},
      TautulliUsersResponseSchema
    );
    return result.response.data ?? [];
  }

  /**
   * Get paginated history from Tautulli
   */
  async getHistory(
    start: number = 0,
    length: number = PAGE_SIZE
  ): Promise<{ records: TautulliHistoryRecord[]; total: number }> {
    const result = await this.request<TautulliHistoryResponse>(
      'get_history',
      {
        start,
        length,
        order_column: 'date',
        order_dir: 'desc',
      },
      TautulliHistoryResponseSchema
    );

    return {
      records: result.response.data?.data ?? [],
      total: result.response.data?.recordsTotal ?? 0,
    };
  }

  /**
   * Import all history from Tautulli into Tracearr
   */
  static async importHistory(
    serverId: string,
    pubSubService?: PubSubService
  ): Promise<TautulliImportResult> {
    // Get Tautulli settings
    const settingsRow = await db
      .select()
      .from(settings)
      .where(eq(settings.id, 1))
      .limit(1);

    const config = settingsRow[0];
    if (!config?.tautulliUrl || !config?.tautulliApiKey) {
      return {
        success: false,
        imported: 0,
        skipped: 0,
        errors: 0,
        message: 'Tautulli is not configured. Please add URL and API key in Settings.',
      };
    }

    const tautulli = new TautulliService(config.tautulliUrl, config.tautulliApiKey);

    // Test connection
    const connected = await tautulli.testConnection();
    if (!connected) {
      return {
        success: false,
        imported: 0,
        skipped: 0,
        errors: 0,
        message: 'Failed to connect to Tautulli. Please check URL and API key.',
      };
    }

    // Initialize progress
    const progress: TautulliImportProgress = {
      status: 'fetching',
      totalRecords: 0,
      processedRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      errorRecords: 0,
      currentPage: 0,
      totalPages: 0,
      message: 'Connecting to Tautulli...',
    };

    const publishProgress = async () => {
      if (pubSubService) {
        await pubSubService.publish('import:progress', progress);
      }
    };

    await publishProgress();

    // Get user mapping (Tautulli user_id → Tracearr user_id)
    const userMap = new Map<number, string>();

    // Get all Tracearr users for this server
    const tracearrUsers = await db
      .select()
      .from(users)
      .where(eq(users.serverId, serverId));

    // Map by externalId (Plex user ID)
    for (const user of tracearrUsers) {
      if (user.externalId) {
        const plexUserId = parseInt(user.externalId, 10);
        if (!isNaN(plexUserId)) {
          userMap.set(plexUserId, user.id);
        }
      }
    }

    // Get total count
    const { total } = await tautulli.getHistory(0, 1);
    progress.totalRecords = total;
    progress.totalPages = Math.ceil(total / PAGE_SIZE);
    progress.message = `Found ${total} records to import`;
    await publishProgress();

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let page = 0;

    // Track skipped users for warning message
    const skippedUsers = new Map<number, { username: string; count: number }>();

    // Process all pages
    while (page * PAGE_SIZE < total) {
      progress.status = 'processing';
      progress.currentPage = page + 1;
      progress.message = `Processing page ${page + 1} of ${progress.totalPages}`;
      await publishProgress();

      const { records } = await tautulli.getHistory(page * PAGE_SIZE, PAGE_SIZE);

      for (const record of records) {
        progress.processedRecords++;

        try {
          // Find Tracearr user by Plex user ID
          const userId = userMap.get(record.user_id);
          if (!userId) {
            // User not found in Tracearr - track for warning
            const existing = skippedUsers.get(record.user_id);
            if (existing) {
              existing.count++;
            } else {
              skippedUsers.set(record.user_id, {
                username: record.friendly_name || record.user,
                count: 1,
              });
            }
            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Skip records without reference_id (active/in-progress sessions)
          if (record.reference_id === null) {
            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Check for existing session by externalSessionId
          // Convert reference_id to string for DB comparison
          const referenceIdStr = String(record.reference_id);
          const existingByRef = await db
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.serverId, serverId),
                eq(sessions.externalSessionId, referenceIdStr)
              )
            )
            .limit(1);

          if (existingByRef.length > 0) {
            // Session already imported - update with final data
            const existing = existingByRef[0]!;
            await db
              .update(sessions)
              .set({
                stoppedAt: new Date(record.stopped * 1000),
                durationMs: record.duration * 1000,
                pausedDurationMs: record.paused_counter * 1000,
                watched: record.watched_status === 1,
                progressMs: Math.round(
                  (record.percent_complete / 100) * (existing.totalDurationMs ?? 0)
                ),
              })
              .where(eq(sessions.id, existing.id));

            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Check for duplicate by ratingKey + startedAt (fallback dedup)
          const startedAt = new Date(record.started * 1000);
          // Convert rating_key to string for DB comparison (can be number or empty string)
          const ratingKeyStr = typeof record.rating_key === 'number' ? String(record.rating_key) : null;
          const existingByTime = ratingKeyStr
            ? await db
                .select()
                .from(sessions)
                .where(
                  and(
                    eq(sessions.serverId, serverId),
                    eq(sessions.userId, userId),
                    eq(sessions.ratingKey, ratingKeyStr),
                    eq(sessions.startedAt, startedAt)
                  )
                )
                .limit(1)
            : [];

          if (existingByTime.length > 0) {
            // Update with externalSessionId for future dedup
            const existingSession = existingByTime[0]!;
            await db
              .update(sessions)
              .set({
                externalSessionId: referenceIdStr,
                stoppedAt: new Date(record.stopped * 1000),
                durationMs: record.duration * 1000,
                pausedDurationMs: record.paused_counter * 1000,
                watched: record.watched_status === 1,
              })
              .where(eq(sessions.id, existingSession.id));

            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Lookup GeoIP data
          const geo = geoipService.lookup(record.ip_address);

          // Map media type
          let mediaType: 'movie' | 'episode' | 'track' = 'movie';
          if (record.media_type === 'episode') {
            mediaType = 'episode';
          } else if (record.media_type === 'track') {
            mediaType = 'track';
          }

          // Insert new session
          // session_key can be string, number, or null - convert to string
          const sessionKey = record.session_key != null
            ? String(record.session_key)
            : `tautulli-${record.reference_id}`;
          await db.insert(sessions).values({
            serverId,
            userId,
            sessionKey,
            // Convert rating_key to string (can be number or empty string from API)
            ratingKey: typeof record.rating_key === 'number' ? String(record.rating_key) : null,
            // reference_id is always a number from API, convert to string
            externalSessionId: String(record.reference_id),
            state: 'stopped', // Historical data is always stopped
            mediaType,
            mediaTitle: record.full_title || record.title,
            // Enhanced metadata from Tautulli
            grandparentTitle: record.grandparent_title || null,
            // Handle number or empty string from API
            seasonNumber: typeof record.parent_media_index === 'number' ? record.parent_media_index : null,
            episodeNumber: typeof record.media_index === 'number' ? record.media_index : null,
            year: record.year || null,
            // Tautulli provides thumb which is season poster for episodes, show/movie poster for others
            thumbPath: record.thumb || null,
            startedAt,
            stoppedAt: new Date(record.stopped * 1000),
            durationMs: record.duration * 1000,
            totalDurationMs: null, // Tautulli doesn't provide total duration directly
            progressMs: null, // Will calculate from percent_complete if needed
            // Pause tracking from Tautulli
            pausedDurationMs: record.paused_counter * 1000,
            watched: record.watched_status === 1,
            // Network/device info
            ipAddress: record.ip_address || '0.0.0.0',
            geoCity: geo.city,
            geoRegion: geo.region,
            geoCountry: geo.country,
            geoLat: geo.lat,
            geoLon: geo.lon,
            playerName: record.player || record.product,
            deviceId: record.machine_id || null,
            product: record.product || null,
            platform: record.platform,
            quality: record.transcode_decision === 'transcode' ? 'Transcode' : 'Direct',
            isTranscode: record.transcode_decision === 'transcode',
            bitrate: null,
          });

          imported++;
          progress.importedRecords++;
        } catch (error) {
          console.error('Error importing record:', record.reference_id, error);
          errors++;
          progress.errorRecords++;
        }

        // Publish progress every 10 records
        if (progress.processedRecords % 10 === 0) {
          await publishProgress();
        }
      }

      page++;
    }

    // Refresh TimescaleDB aggregates so imported data appears in stats immediately
    progress.message = 'Refreshing aggregates...';
    await publishProgress();
    try {
      await refreshAggregates();
    } catch (err) {
      console.warn('Failed to refresh aggregates after import:', err);
    }

    // Build final message with skipped user warnings
    let message = `Import complete: ${imported} imported, ${skipped} skipped, ${errors} errors`;

    if (skippedUsers.size > 0) {
      const skippedUserList = [...skippedUsers.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 5) // Show top 5 skipped users
        .map(u => `${u.username} (${u.count} records)`)
        .join(', ');

      const moreUsers = skippedUsers.size > 5 ? ` and ${skippedUsers.size - 5} more` : '';
      message += `. Warning: ${skippedUsers.size} users not found in Tracearr: ${skippedUserList}${moreUsers}. Sync your server to import these users first.`;

      console.warn(`Tautulli import skipped users: ${[...skippedUsers.values()].map(u => u.username).join(', ')}`);
    }

    // Final progress update
    progress.status = 'complete';
    progress.message = message;
    await publishProgress();

    return {
      success: true,
      imported,
      skipped,
      errors,
      message,
      skippedUsers: skippedUsers.size > 0 ? [...skippedUsers.entries()].map(([id, data]) => ({
        tautulliUserId: id,
        username: data.username,
        recordCount: data.count,
      })) : undefined,
    };
  }
}
