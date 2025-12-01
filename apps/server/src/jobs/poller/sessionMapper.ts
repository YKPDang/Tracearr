/**
 * Session Mapping Functions
 *
 * Functions to transform sessions between different formats:
 * - MediaSession (from mediaServer adapter) → ProcessedSession (for DB storage)
 * - Database row → Session type (for application use)
 */

import type { Session } from '@tracearr/shared';
import type { MediaSession } from '../../services/mediaServer/types.js';
import type { ProcessedSession } from './types.js';
import { isPrivateIP, parseJellyfinClient } from './utils.js';
import { sessions } from '../../db/schema.js';

// ============================================================================
// MediaSession → ProcessedSession Mapping
// ============================================================================

/**
 * Map unified MediaSession to ProcessedSession format
 * Works for both Plex and Jellyfin sessions from the new adapter
 *
 * @param session - Unified MediaSession from the mediaServer adapter
 * @param serverType - Type of media server ('plex' | 'jellyfin')
 * @returns ProcessedSession ready for database storage
 *
 * @example
 * const processed = mapMediaSession(mediaSession, 'plex');
 * // Use processed for DB insert
 */
export function mapMediaSession(
  session: MediaSession,
  serverType: 'plex' | 'jellyfin'
): ProcessedSession {
  const isEpisode = session.media.type === 'episode';

  // For episodes, prefer show poster; for movies, use media poster
  const thumbPath = isEpisode && session.episode?.showThumbPath
    ? session.episode.showThumbPath
    : session.media.thumbPath ?? '';

  // Build quality string from bitrate (bitrate is in kbps, convert to Mbps)
  const quality = session.quality.bitrate > 0
    ? `${Math.round(session.quality.bitrate / 1000)}Mbps`
    : session.quality.isTranscode
      ? 'Transcoding'
      : 'Direct';

  // Filter private IPs for Jellyfin to avoid GeoIP lookup failures
  const ipAddress = serverType === 'jellyfin' && isPrivateIP(session.network.ipAddress)
    ? ''
    : session.network.ipAddress;

  // Get platform/device - Jellyfin may need client string parsing
  let platform = session.player.platform ?? '';
  let device = session.player.device ?? '';
  if (serverType === 'jellyfin' && session.player.product) {
    const parsed = parseJellyfinClient(session.player.product, device);
    platform = platform || parsed.platform;
    device = device || parsed.device;
  }

  return {
    sessionKey: session.sessionKey,
    ratingKey: session.mediaId,
    // User data
    externalUserId: session.user.id,
    username: session.user.username || 'Unknown',
    userThumb: session.user.thumb ?? '',
    mediaTitle: session.media.title,
    mediaType: session.media.type === 'movie' ? 'movie'
      : session.media.type === 'episode' ? 'episode'
      : 'track',
    // Enhanced media metadata
    grandparentTitle: session.episode?.showTitle ?? '',
    seasonNumber: session.episode?.seasonNumber ?? 0,
    episodeNumber: session.episode?.episodeNumber ?? 0,
    year: session.media.year ?? 0,
    thumbPath,
    // Connection info
    ipAddress,
    playerName: session.player.name,
    deviceId: session.player.deviceId,
    product: session.player.product ?? '',
    device,
    platform,
    quality,
    isTranscode: session.quality.isTranscode,
    bitrate: session.quality.bitrate,
    state: session.playback.state === 'paused' ? 'paused' : 'playing',
    totalDurationMs: session.media.durationMs,
    progressMs: session.playback.positionMs,
    // Jellyfin provides exact pause timestamp for more accurate tracking
    lastPausedDate: session.lastPausedDate,
  };
}

// ============================================================================
// Database Row → Session Mapping
// ============================================================================

/**
 * Map a database session row to the Session type
 *
 * @param s - Database session row from drizzle select
 * @returns Session object for application use
 *
 * @example
 * const rows = await db.select().from(sessions).where(...);
 * const sessionObjects = rows.map(mapSessionRow);
 */
export function mapSessionRow(s: typeof sessions.$inferSelect): Session {
  return {
    id: s.id,
    serverId: s.serverId,
    userId: s.userId,
    sessionKey: s.sessionKey,
    state: s.state,
    mediaType: s.mediaType,
    mediaTitle: s.mediaTitle,
    grandparentTitle: s.grandparentTitle,
    seasonNumber: s.seasonNumber,
    episodeNumber: s.episodeNumber,
    year: s.year,
    thumbPath: s.thumbPath,
    ratingKey: s.ratingKey,
    externalSessionId: s.externalSessionId,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt,
    durationMs: s.durationMs,
    totalDurationMs: s.totalDurationMs,
    progressMs: s.progressMs,
    lastPausedAt: s.lastPausedAt,
    pausedDurationMs: s.pausedDurationMs,
    referenceId: s.referenceId,
    watched: s.watched,
    ipAddress: s.ipAddress,
    geoCity: s.geoCity,
    geoRegion: s.geoRegion,
    geoCountry: s.geoCountry,
    geoLat: s.geoLat,
    geoLon: s.geoLon,
    playerName: s.playerName,
    deviceId: s.deviceId,
    product: s.product,
    device: s.device,
    platform: s.platform,
    quality: s.quality,
    isTranscode: s.isTranscode,
    bitrate: s.bitrate,
  };
}
