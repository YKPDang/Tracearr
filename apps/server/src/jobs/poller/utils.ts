/**
 * Poller Utility Functions
 *
 * Pure utility functions for IP detection, client parsing, and formatting.
 * These functions have no side effects and are easily testable.
 */

import { normalizeClient } from '../../utils/platformNormalizer.js';

export const parseJellyfinClient = normalizeClient;

// ============================================================================
// IP Address Utilities
// ============================================================================

/**
 * Check if an IP address is private/local (won't have GeoIP data)
 *
 * @param ip - IP address to check
 * @returns true if the IP is private/local
 *
 * @example
 * isPrivateIP('192.168.1.100'); // true
 * isPrivateIP('8.8.8.8');       // false
 */
export function isPrivateIP(ip: string): boolean {
  if (!ip) return true;

  // IPv4 private ranges
  const privateIPv4 = [
    /^10\./, // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
    /^192\.168\./, // 192.168.0.0/16
    /^127\./, // Loopback
    /^169\.254\./, // Link-local
    /^0\./, // Current network
  ];

  // IPv6 private ranges
  const privateIPv6 = [
    /^::1$/i, // Loopback
    /^fe80:/i, // Link-local
    /^fc/i, // Unique local
    /^fd/i, // Unique local
  ];

  return privateIPv4.some((r) => r.test(ip)) || privateIPv6.some((r) => r.test(ip));
}

// ============================================================================
// Formatting Utilities
// ============================================================================

/**
 * Format quality string from bitrate and transcoding info
 *
 * @param transcodeBitrate - Transcoded bitrate in bps (0 if not transcoding)
 * @param sourceBitrate - Original source bitrate in bps
 * @param isTranscoding - Whether the stream is being transcoded
 * @returns Formatted quality string (e.g., "12Mbps", "Transcoding", "Direct")
 *
 * @example
 * formatQualityString(12000000, 20000000, true);  // "12Mbps"
 * formatQualityString(0, 0, true);                 // "Transcoding"
 * formatQualityString(0, 0, false);                // "Direct"
 */
export function formatQualityString(
  transcodeBitrate: number,
  sourceBitrate: number,
  isTranscoding: boolean
): string {
  const bitrate = transcodeBitrate || sourceBitrate;
  return bitrate > 0
    ? `${Math.round(bitrate / 1000000)}Mbps`
    : isTranscoding
      ? 'Transcoding'
      : 'Direct';
}
