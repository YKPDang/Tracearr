/**
 * Jellyfin Authentication Routes
 *
 * POST /jellyfin/connect - Connect a Jellyfin server (requires authentication)
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';
import { JellyfinClient } from '../../services/mediaServer/index.js';
import { encrypt } from '../../utils/crypto.js';
import { generateTokens } from './utils.js';

// Schema
const jellyfinConnectSchema = z.object({
  serverUrl: z.url(),
  serverName: z.string().min(1).max(100),
  username: z.string().min(1),
  password: z.string().min(1),
});

export const jellyfinRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /jellyfin/connect - Connect a Jellyfin server (requires authentication)
   */
  app.post(
    '/jellyfin/connect',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const body = jellyfinConnectSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('serverUrl, serverName, username, and password are required');
      }

      const authUser = request.user;

      // Only owners can add servers
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only owners can add servers');
      }

      const { serverUrl, serverName, username, password } = body.data;

      try {
        const authResult = await JellyfinClient.authenticate(serverUrl, username, password);

        if (!authResult) {
          return reply.unauthorized('Invalid Jellyfin credentials');
        }

        if (!authResult.isAdmin) {
          return reply.forbidden('You must be an administrator on the Jellyfin server');
        }

        // Create or update server
        let server = await db
          .select()
          .from(servers)
          .where(and(eq(servers.url, serverUrl), eq(servers.type, 'jellyfin')))
          .limit(1);

        if (server.length === 0) {
          const inserted = await db
            .insert(servers)
            .values({
              name: serverName,
              type: 'jellyfin',
              url: serverUrl,
              token: encrypt(authResult.token),
            })
            .returning();
          server = inserted;
        } else {
          const existingServer = server[0]!;
          await db
            .update(servers)
            .set({
              name: serverName,
              token: encrypt(authResult.token),
              updatedAt: new Date(),
            })
            .where(eq(servers.id, existingServer.id));
        }

        const serverId = server[0]!.id;

        app.log.info({ userId: authUser.userId, serverId }, 'Jellyfin server connected');

        // Return updated tokens with new server access
        return generateTokens(app, authUser.userId, authUser.username, true);
      } catch (error) {
        app.log.error({ error }, 'Jellyfin connect failed');
        return reply.internalServerError('Failed to connect Jellyfin server');
      }
    }
  );
};
