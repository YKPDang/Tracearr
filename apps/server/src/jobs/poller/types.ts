/**
 * Poller Type Definitions
 *
 * Shared interfaces and types for the session polling system.
 * Separated from implementation for clean imports and testing.
 */

import type { Session, SessionState, Rule, RuleParams } from '@tracearr/shared';

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for the poller job
 */
export interface PollerConfig {
  /** Whether polling is enabled */
  enabled: boolean;
  /** Polling interval in milliseconds */
  intervalMs: number;
}

// ============================================================================
// Server Types
// ============================================================================

/**
 * Server data with decrypted token for API calls
 */
export interface ServerWithToken {
  id: string;
  name: string;
  type: 'plex' | 'jellyfin';
  url: string;
  token: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Session Types
// ============================================================================

/**
 * Processed session format after mapping from MediaSession
 * Contains all fields needed for database storage and display
 */
export interface ProcessedSession {
  /** Unique session key from media server */
  sessionKey: string;
  /** Media item identifier (ratingKey for Plex, itemId for Jellyfin) */
  ratingKey: string;

  // User identification from media server
  /** External user ID from Plex/Jellyfin for lookup */
  externalUserId: string;
  /** Display name from media server */
  username: string;
  /** Avatar URL from media server */
  userThumb: string;

  // Media metadata
  /** Media title */
  mediaTitle: string;
  /** Media type classification */
  mediaType: 'movie' | 'episode' | 'track';
  /** Show name (for episodes) */
  grandparentTitle: string;
  /** Season number (for episodes) */
  seasonNumber: number;
  /** Episode number (for episodes) */
  episodeNumber: number;
  /** Release year */
  year: number;
  /** Poster path */
  thumbPath: string;

  // Connection info
  /** Client IP address */
  ipAddress: string;
  /** Player/device name */
  playerName: string;
  /** Unique device identifier */
  deviceId: string;
  /** Product/app name (e.g., "Plex for iOS") */
  product: string;
  /** Device type (e.g., "iPhone") */
  device: string;
  /** Platform (e.g., "iOS") */
  platform: string;

  // Quality info
  /** Quality display string */
  quality: string;
  /** Whether stream is transcoded */
  isTranscode: boolean;
  /** Bitrate in kbps */
  bitrate: number;

  // Playback state
  /** Current playback state */
  state: 'playing' | 'paused';
  /** Total media duration in milliseconds */
  totalDurationMs: number;
  /** Current playback position in milliseconds */
  progressMs: number;

  /**
   * Jellyfin-specific: When the current pause started (from API).
   * More accurate than tracking pause transitions via polling.
   */
  lastPausedDate?: Date;
}

// ============================================================================
// Pause Tracking Types
// ============================================================================

/**
 * Result of pause accumulation calculation
 */
export interface PauseAccumulationResult {
  /** Timestamp when pause started (null if playing) */
  lastPausedAt: Date | null;
  /** Total accumulated pause duration in milliseconds */
  pausedDurationMs: number;
}

/**
 * Result of stop duration calculation
 */
export interface StopDurationResult {
  /** Actual watch duration excluding pause time in milliseconds */
  durationMs: number;
  /** Final total paused duration in milliseconds */
  finalPausedDurationMs: number;
}

/**
 * Session data needed for pause calculations
 */
export interface SessionPauseData {
  startedAt: Date;
  lastPausedAt: Date | null;
  pausedDurationMs: number;
}

// ============================================================================
// Processing Results
// ============================================================================

/**
 * Result of processing a single server's sessions
 */
export interface ServerProcessingResult {
  /** Newly created sessions */
  newSessions: import('@tracearr/shared').ActiveSession[];
  /** Session keys that stopped playing */
  stoppedSessionKeys: string[];
  /** Sessions that were updated (state change, progress, etc.) */
  updatedSessions: import('@tracearr/shared').ActiveSession[];
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { Session, SessionState, Rule, RuleParams };
