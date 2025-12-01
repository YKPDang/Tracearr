/**
 * Plex Authentication Routes
 *
 * POST /plex/check-pin - Check Plex PIN status
 * POST /plex/connect - Complete Plex signup and connect a server
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { servers, users } from '../../db/schema.js';
import { PlexClient } from '../../services/mediaServer/index.js';
import { encrypt } from '../../utils/crypto.js';
import {
  generateTokens,
  generateTempToken,
  PLEX_TEMP_TOKEN_PREFIX,
  PLEX_TEMP_TOKEN_TTL,
} from './utils.js';
import { getUserByPlexAccountId, getOwnerUser } from '../../services/userService.js';

// Schemas
const plexCheckPinSchema = z.object({
  pinId: z.string(),
});

const plexConnectSchema = z.object({
  tempToken: z.string(),
  serverUri: z.url(),
  serverName: z.string().min(1).max(100),
});

export const plexRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /plex/check-pin - Check Plex PIN status
   *
   * Returns:
   * - { authorized: false } if PIN not yet claimed
   * - { authorized: true, accessToken, refreshToken, user } if user found by plexAccountId
   * - { authorized: true, needsServerSelection: true, servers, tempToken } if new Plex user
   */
  app.post('/plex/check-pin', async (request, reply) => {
    const body = plexCheckPinSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('pinId is required');
    }

    const { pinId } = body.data;

    try {
      const authResult = await PlexClient.checkOAuthPin(pinId);

      if (!authResult) {
        return { authorized: false, message: 'PIN not yet authorized' };
      }

      // Check if user exists by Plex account ID (global Plex.tv ID)
      let existingUser = await getUserByPlexAccountId(authResult.id);

      // Fallback: Check by external_id (server-synced users may have Plex ID there)
      if (!existingUser) {
        const fallbackUsers = await db
          .select()
          .from(users)
          .where(eq(users.externalId, authResult.id))
          .limit(1);
        existingUser = fallbackUsers[0] ?? null;
      }

      if (existingUser) {
        // Returning Plex user - update their info and link plex_account_id
        const user = existingUser;

        await db
          .update(users)
          .set({
            username: authResult.username,
            email: authResult.email,
            thumbUrl: authResult.thumb,
            plexAccountId: authResult.id, // Link the Plex account ID
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));

        app.log.info({ userId: user.id }, 'Returning Plex user login');

        return {
          authorized: true,
          ...(await generateTokens(app, user.id, authResult.username, user.isOwner)),
        };
      }

      // New Plex user - check if they own any servers
      const plexServers = await PlexClient.getServers(authResult.token);

      // Check if this is the first owner
      const owner = await getOwnerUser();
      const isFirstUser = !owner;

      // Store temp token for completing registration
      const tempToken = generateTempToken();
      await app.redis.setex(
        `${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`,
        PLEX_TEMP_TOKEN_TTL,
        JSON.stringify({
          plexAccountId: authResult.id,
          plexUsername: authResult.username,
          plexEmail: authResult.email,
          plexThumb: authResult.thumb,
          plexToken: authResult.token,
          isFirstUser,
        })
      );

      // If they have servers, let them select one to connect
      if (plexServers.length > 0) {
        const formattedServers = plexServers.map((s) => ({
          name: s.name,
          platform: s.platform,
          version: s.productVersion,
          connections: s.connections.map((c) => ({
            uri: c.uri,
            local: c.local,
            address: c.address,
            port: c.port,
          })),
        }));

        return {
          authorized: true,
          needsServerSelection: true,
          servers: formattedServers,
          tempToken,
        };
      }

      // No servers - create account without server connection
      const [newUser] = await db
        .insert(users)
        .values({
          username: authResult.username,
          email: authResult.email,
          thumbUrl: authResult.thumb,
          plexAccountId: authResult.id,
          isOwner: isFirstUser,
        })
        .returning();

      if (!newUser) {
        return reply.internalServerError('Failed to create user');
      }

      // Clean up temp token
      await app.redis.del(`${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`);

      app.log.info({ userId: newUser.id, isOwner: isFirstUser }, 'New Plex user created (no servers)');

      return {
        authorized: true,
        ...(await generateTokens(app, newUser.id, newUser.username, newUser.isOwner)),
      };
    } catch (error) {
      app.log.error({ error }, 'Plex check-pin failed');
      return reply.internalServerError('Failed to check Plex authorization');
    }
  });

  /**
   * POST /plex/connect - Complete Plex signup and connect a server
   */
  app.post('/plex/connect', async (request, reply) => {
    const body = plexConnectSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('tempToken, serverUri, and serverName are required');
    }

    const { tempToken, serverUri, serverName } = body.data;

    // Get stored Plex auth from temp token
    const stored = await app.redis.get(`${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`);
    if (!stored) {
      return reply.unauthorized('Invalid or expired temp token. Please restart login.');
    }

    // Delete temp token (one-time use)
    await app.redis.del(`${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`);

    const { plexAccountId, plexUsername, plexEmail, plexThumb, plexToken, isFirstUser } = JSON.parse(
      stored
    ) as {
      plexAccountId: string;
      plexUsername: string;
      plexEmail: string;
      plexThumb: string;
      plexToken: string;
      isFirstUser: boolean;
    };

    try {
      // Verify user is admin on the selected server
      const isAdmin = await PlexClient.verifyServerAdmin(plexToken, serverUri);
      if (!isAdmin) {
        return reply.forbidden('You must be an admin on the selected Plex server');
      }

      // Create or update server
      let server = await db
        .select()
        .from(servers)
        .where(and(eq(servers.url, serverUri), eq(servers.type, 'plex')))
        .limit(1);

      if (server.length === 0) {
        const inserted = await db
          .insert(servers)
          .values({
            name: serverName,
            type: 'plex',
            url: serverUri,
            token: encrypt(plexToken),
          })
          .returning();
        server = inserted;
      } else {
        const existingServer = server[0]!;
        await db
          .update(servers)
          .set({ token: encrypt(plexToken), updatedAt: new Date() })
          .where(eq(servers.id, existingServer.id));
      }

      const serverId = server[0]!.id;

      // Create user with Plex account ID
      const [newUser] = await db
        .insert(users)
        .values({
          serverId,
          username: plexUsername,
          email: plexEmail,
          thumbUrl: plexThumb,
          plexAccountId: plexAccountId,
          isOwner: isFirstUser,
        })
        .returning();

      if (!newUser) {
        return reply.internalServerError('Failed to create user');
      }

      app.log.info({ userId: newUser.id, serverId, isOwner: isFirstUser }, 'New Plex user with server created');

      return generateTokens(app, newUser.id, newUser.username, newUser.isOwner);
    } catch (error) {
      app.log.error({ error }, 'Plex connect failed');
      return reply.internalServerError('Failed to connect to Plex server');
    }
  });
};
