/**
 * Auth Route Utilities
 *
 * Shared helpers for authentication routes including token generation,
 * hashing, and Redis key management.
 */

import { createHash, randomBytes } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { JWT_CONFIG, type AuthUser } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';

// Redis key prefixes
export const REFRESH_TOKEN_PREFIX = 'tracearr:refresh:';
export const PLEX_TEMP_TOKEN_PREFIX = 'tracearr:plex_temp:';
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
export const PLEX_TEMP_TOKEN_TTL = 10 * 60; // 10 minutes for server selection

/**
 * Generate a random refresh token
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Hash a refresh token for secure storage
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a temporary token for Plex OAuth flow
 */
export function generateTempToken(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Get all server IDs for owner tokens
 */
export async function getAllServerIds(): Promise<string[]> {
  const allServers = await db.select({ id: servers.id }).from(servers);
  return allServers.map((s) => s.id);
}

/**
 * Generate access and refresh tokens for a user
 */
export async function generateTokens(
  app: FastifyInstance,
  userId: string,
  username: string,
  isOwner: boolean
) {
  // Owners get access to ALL servers
  const serverIds = isOwner ? await getAllServerIds() : [];

  const accessPayload: AuthUser = {
    userId,
    username,
    role: isOwner ? 'owner' : 'guest',
    serverIds,
  };

  const accessToken = app.jwt.sign(accessPayload, {
    expiresIn: JWT_CONFIG.ACCESS_TOKEN_EXPIRY,
  });

  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);

  await app.redis.setex(
    `${REFRESH_TOKEN_PREFIX}${refreshTokenHash}`,
    REFRESH_TOKEN_TTL,
    JSON.stringify({ userId, serverIds })
  );

  return { accessToken, refreshToken, user: accessPayload };
}
