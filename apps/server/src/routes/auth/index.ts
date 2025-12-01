/**
 * Authentication Routes Module
 *
 * Orchestrates all auth-related routes and provides unified export.
 *
 * Auth Flow Options:
 * 1. Local signup: POST /signup → Create account with username/password
 * 2. Local login: POST /login (type=local) → Login with username/password
 * 3. Plex OAuth: POST /login (type=plex) → Login/signup with Plex
 *
 * Server Connection (separate from auth):
 * - POST /plex/connect → Connect a Plex server after login
 * - POST /jellyfin/connect → Connect a Jellyfin server after login
 *
 * Session Management:
 * - GET /me → Get current user info
 * - POST /refresh → Refresh access token
 * - POST /logout → Revoke refresh token
 */

import type { FastifyPluginAsync } from 'fastify';
import { localRoutes } from './local.js';
import { plexRoutes } from './plex.js';
import { jellyfinRoutes } from './jellyfin.js';
import { sessionRoutes } from './session.js';

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Register all sub-route plugins
  // Each plugin defines its own paths (no additional prefix needed)
  await app.register(localRoutes);
  await app.register(plexRoutes);
  await app.register(jellyfinRoutes);
  await app.register(sessionRoutes);
};

// Re-export utilities for potential use by other modules
export {
  generateTokens,
  generateRefreshToken,
  hashRefreshToken,
  getAllServerIds,
} from './utils.js';
