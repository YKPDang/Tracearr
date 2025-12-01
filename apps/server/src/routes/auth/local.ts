/**
 * Local Authentication Routes
 *
 * POST /signup - Create a local account
 * POST /login - Login with local credentials or initiate Plex OAuth
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { PlexClient } from '../../services/mediaServer/index.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { generateTokens } from './utils.js';
import { getUserByUsername, getOwnerUser } from '../../services/userService.js';

// Schemas
const signupSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(8).max(100),
  email: z.email().optional(),
});

const localLoginSchema = z.object({
  type: z.literal('local'),
  username: z.string().min(1),
  password: z.string().min(1),
});

const plexLoginSchema = z.object({
  type: z.literal('plex'),
});

const loginSchema = z.discriminatedUnion('type', [localLoginSchema, plexLoginSchema]);

export const localRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /signup - Create a local account
   */
  app.post('/signup', async (request, reply) => {
    const body = signupSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid signup data: username (3-50 chars), password (8+ chars) required');
    }

    const { username, password, email } = body.data;

    // Check if username already exists
    const existing = await getUserByUsername(username);
    if (existing) {
      return reply.conflict('Username already taken');
    }

    // Check if this is the first user (will be owner)
    const owner = await getOwnerUser();
    const isFirstUser = !owner;

    // Create user with password hash
    const passwordHashValue = await hashPassword(password);

    const [newUser] = await db
      .insert(users)
      .values({
        username,
        email: email ?? null,
        passwordHash: passwordHashValue,
        isOwner: isFirstUser, // First user is always owner
        // serverId and externalId are null for local accounts
      })
      .returning();

    if (!newUser) {
      return reply.internalServerError('Failed to create user');
    }

    app.log.info({ userId: newUser.id, isOwner: isFirstUser }, 'Local account created');

    return generateTokens(app, newUser.id, newUser.username, newUser.isOwner);
  });

  /**
   * POST /login - Login with local credentials or initiate Plex OAuth
   */
  app.post('/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid login request');
    }

    const { type } = body.data;

    if (type === 'local') {
      const { username, password } = body.data;

      // Find user by username with password hash
      const userRows = await db
        .select()
        .from(users)
        .where(and(eq(users.username, username), isNotNull(users.passwordHash)))
        .limit(1);

      const user = userRows[0];
      if (!user?.passwordHash) {
        return reply.unauthorized('Invalid username or password');
      }

      // Verify password
      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return reply.unauthorized('Invalid username or password');
      }

      app.log.info({ userId: user.id }, 'Local login successful');

      return generateTokens(app, user.id, user.username, user.isOwner);
    }

    // Plex OAuth - initiate flow
    try {
      const { pinId, authUrl } = await PlexClient.initiateOAuth();
      return { pinId, authUrl };
    } catch (error) {
      app.log.error({ error }, 'Failed to initiate Plex OAuth');
      return reply.internalServerError('Failed to initiate Plex authentication');
    }
  });
};
