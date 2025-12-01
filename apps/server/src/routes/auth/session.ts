/**
 * Session Management Routes
 *
 * POST /refresh - Refresh access token
 * POST /logout - Revoke refresh token
 * GET /me - Get current user info
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { JWT_CONFIG, type AuthUser } from '@tracearr/shared';
import {
  generateRefreshToken,
  hashRefreshToken,
  getAllServerIds,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL,
} from './utils.js';
import { getUserById } from '../../services/userService.js';

// Schema
const refreshSchema = z.object({
  refreshToken: z.string(),
});

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /refresh - Refresh access token
   */
  app.post('/refresh', async (request, reply) => {
    const body = refreshSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { refreshToken } = body.data;
    const refreshTokenHash = hashRefreshToken(refreshToken);

    const stored = await app.redis.get(`${REFRESH_TOKEN_PREFIX}${refreshTokenHash}`);
    if (!stored) {
      return reply.unauthorized('Invalid or expired refresh token');
    }

    const { userId } = JSON.parse(stored) as { userId: string; serverIds: string[] };

    const user = await getUserById(userId);

    if (!user) {
      await app.redis.del(`${REFRESH_TOKEN_PREFIX}${refreshTokenHash}`);
      return reply.unauthorized('User not found');
    }

    // Get fresh server IDs (in case servers were added/removed)
    const serverIds = user.isOwner ? await getAllServerIds() : [];

    const accessPayload: AuthUser = {
      userId,
      username: user.username,
      role: user.isOwner ? 'owner' : 'guest',
      serverIds,
    };

    const accessToken = app.jwt.sign(accessPayload, {
      expiresIn: JWT_CONFIG.ACCESS_TOKEN_EXPIRY,
    });

    // Rotate refresh token
    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = hashRefreshToken(newRefreshToken);

    await app.redis.del(`${REFRESH_TOKEN_PREFIX}${refreshTokenHash}`);
    await app.redis.setex(
      `${REFRESH_TOKEN_PREFIX}${newRefreshTokenHash}`,
      REFRESH_TOKEN_TTL,
      JSON.stringify({ userId, serverIds })
    );

    return { accessToken, refreshToken: newRefreshToken };
  });

  /**
   * POST /logout - Revoke refresh token
   */
  app.post('/logout', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = refreshSchema.safeParse(request.body);

    if (body.success) {
      const { refreshToken } = body.data;
      await app.redis.del(`${REFRESH_TOKEN_PREFIX}${hashRefreshToken(refreshToken)}`);
    }

    reply.clearCookie('token');
    return { success: true };
  });

  /**
   * GET /me - Get current user info
   */
  app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
    const authUser = request.user;

    const user = await getUserById(authUser.userId);

    if (!user) {
      // User in JWT doesn't exist in database - token is invalid
      throw app.httpErrors.unauthorized('User no longer exists');
    }

    // Get fresh server IDs
    const serverIds = user.isOwner ? await getAllServerIds() : [];

    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      thumbUrl: user.thumbUrl,
      role: user.isOwner ? 'owner' : 'guest',
      trustScore: user.trustScore,
      serverIds,
      hasPassword: !!user.passwordHash,
      hasPlexLinked: !!user.plexAccountId,
    };
  });
};
