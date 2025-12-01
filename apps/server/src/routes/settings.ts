/**
 * Settings routes - Application configuration
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { updateSettingsSchema, type Settings } from '@tracearr/shared';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';

// Default settings row ID (singleton pattern)
const SETTINGS_ID = 1;

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /settings - Get application settings
   */
  app.get(
    '/',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;

      // Only owners can view settings
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can view settings');
      }

      // Get or create settings
      let settingsRow = await db
        .select()
        .from(settings)
        .where(eq(settings.id, SETTINGS_ID))
        .limit(1);

      // Create default settings if not exists
      if (settingsRow.length === 0) {
        const inserted = await db
          .insert(settings)
          .values({
            id: SETTINGS_ID,
            allowGuestAccess: false,
            notifyOnViolation: true,
            notifyOnSessionStart: false,
            notifyOnSessionStop: false,
            notifyOnServerDown: true,
          })
          .returning();
        settingsRow = inserted;
      }

      const row = settingsRow[0];
      if (!row) {
        return reply.internalServerError('Failed to load settings');
      }

      const result: Settings = {
        allowGuestAccess: row.allowGuestAccess,
        discordWebhookUrl: row.discordWebhookUrl,
        customWebhookUrl: row.customWebhookUrl,
        notifyOnViolation: row.notifyOnViolation,
        notifyOnSessionStart: row.notifyOnSessionStart,
        notifyOnSessionStop: row.notifyOnSessionStop,
        notifyOnServerDown: row.notifyOnServerDown,
        pollerEnabled: row.pollerEnabled,
        pollerIntervalMs: row.pollerIntervalMs,
        tautulliUrl: row.tautulliUrl,
        tautulliApiKey: row.tautulliApiKey ? '********' : null, // Mask API key
        externalUrl: row.externalUrl,
        basePath: row.basePath,
        trustProxy: row.trustProxy,
      };

      return result;
    }
  );

  /**
   * PATCH /settings - Update application settings
   */
  app.patch(
    '/',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const body = updateSettingsSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('Invalid request body');
      }

      const authUser = request.user;

      // Only owners can update settings
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can update settings');
      }

      // Build update object
      const updateData: Partial<{
        allowGuestAccess: boolean;
        discordWebhookUrl: string | null;
        customWebhookUrl: string | null;
        notifyOnViolation: boolean;
        notifyOnSessionStart: boolean;
        notifyOnSessionStop: boolean;
        notifyOnServerDown: boolean;
        pollerEnabled: boolean;
        pollerIntervalMs: number;
        tautulliUrl: string | null;
        tautulliApiKey: string | null;
        externalUrl: string | null;
        basePath: string;
        trustProxy: boolean;
        updatedAt: Date;
      }> = {
        updatedAt: new Date(),
      };

      if (body.data.allowGuestAccess !== undefined) {
        updateData.allowGuestAccess = body.data.allowGuestAccess;
      }

      if (body.data.discordWebhookUrl !== undefined) {
        updateData.discordWebhookUrl = body.data.discordWebhookUrl;
      }

      if (body.data.customWebhookUrl !== undefined) {
        updateData.customWebhookUrl = body.data.customWebhookUrl;
      }

      if (body.data.notifyOnViolation !== undefined) {
        updateData.notifyOnViolation = body.data.notifyOnViolation;
      }

      if (body.data.notifyOnSessionStart !== undefined) {
        updateData.notifyOnSessionStart = body.data.notifyOnSessionStart;
      }

      if (body.data.notifyOnSessionStop !== undefined) {
        updateData.notifyOnSessionStop = body.data.notifyOnSessionStop;
      }

      if (body.data.notifyOnServerDown !== undefined) {
        updateData.notifyOnServerDown = body.data.notifyOnServerDown;
      }

      if (body.data.pollerEnabled !== undefined) {
        updateData.pollerEnabled = body.data.pollerEnabled;
      }

      if (body.data.pollerIntervalMs !== undefined) {
        updateData.pollerIntervalMs = body.data.pollerIntervalMs;
      }

      if (body.data.tautulliUrl !== undefined) {
        updateData.tautulliUrl = body.data.tautulliUrl;
      }

      if (body.data.tautulliApiKey !== undefined) {
        // Store API key as-is (could encrypt if needed)
        updateData.tautulliApiKey = body.data.tautulliApiKey;
      }

      if (body.data.externalUrl !== undefined) {
        // Strip trailing slash for consistency
        updateData.externalUrl = body.data.externalUrl?.replace(/\/+$/, '') ?? null;
      }

      if (body.data.basePath !== undefined) {
        // Normalize base path: ensure leading slash, no trailing slash
        let path = body.data.basePath.trim();
        if (path && !path.startsWith('/')) {
          path = '/' + path;
        }
        path = path.replace(/\/+$/, '');
        updateData.basePath = path;
      }

      if (body.data.trustProxy !== undefined) {
        updateData.trustProxy = body.data.trustProxy;
      }

      // Ensure settings row exists
      const existing = await db
        .select()
        .from(settings)
        .where(eq(settings.id, SETTINGS_ID))
        .limit(1);

      if (existing.length === 0) {
        // Create with provided values
        await db.insert(settings).values({
          id: SETTINGS_ID,
          allowGuestAccess: updateData.allowGuestAccess ?? false,
          discordWebhookUrl: updateData.discordWebhookUrl ?? null,
          customWebhookUrl: updateData.customWebhookUrl ?? null,
          notifyOnViolation: updateData.notifyOnViolation ?? true,
          notifyOnSessionStart: updateData.notifyOnSessionStart ?? false,
          notifyOnSessionStop: updateData.notifyOnSessionStop ?? false,
          notifyOnServerDown: updateData.notifyOnServerDown ?? true,
        });
      } else {
        // Update existing
        await db
          .update(settings)
          .set(updateData)
          .where(eq(settings.id, SETTINGS_ID));
      }

      // Return updated settings
      const updated = await db
        .select()
        .from(settings)
        .where(eq(settings.id, SETTINGS_ID))
        .limit(1);

      const row = updated[0];
      if (!row) {
        return reply.internalServerError('Failed to update settings');
      }

      const result: Settings = {
        allowGuestAccess: row.allowGuestAccess,
        discordWebhookUrl: row.discordWebhookUrl,
        customWebhookUrl: row.customWebhookUrl,
        notifyOnViolation: row.notifyOnViolation,
        notifyOnSessionStart: row.notifyOnSessionStart,
        notifyOnSessionStop: row.notifyOnSessionStop,
        notifyOnServerDown: row.notifyOnServerDown,
        pollerEnabled: row.pollerEnabled,
        pollerIntervalMs: row.pollerIntervalMs,
        tautulliUrl: row.tautulliUrl,
        tautulliApiKey: row.tautulliApiKey ? '********' : null, // Mask API key
        externalUrl: row.externalUrl,
        basePath: row.basePath,
        trustProxy: row.trustProxy,
      };

      return result;
    }
  );
};

/**
 * Get poller settings from database (for internal use by poller)
 */
export async function getPollerSettings(): Promise<{ enabled: boolean; intervalMs: number }> {
  const row = await db
    .select({
      pollerEnabled: settings.pollerEnabled,
      pollerIntervalMs: settings.pollerIntervalMs,
    })
    .from(settings)
    .where(eq(settings.id, SETTINGS_ID))
    .limit(1);

  const settingsRow = row[0];
  if (!settingsRow) {
    // Return defaults if settings don't exist yet
    return { enabled: true, intervalMs: 15000 };
  }

  return {
    enabled: settingsRow.pollerEnabled,
    intervalMs: settingsRow.pollerIntervalMs,
  };
}

/**
 * Get network settings from database (for internal use)
 */
export async function getNetworkSettings(): Promise<{
  externalUrl: string | null;
  basePath: string;
  trustProxy: boolean;
}> {
  const row = await db
    .select({
      externalUrl: settings.externalUrl,
      basePath: settings.basePath,
      trustProxy: settings.trustProxy,
    })
    .from(settings)
    .where(eq(settings.id, SETTINGS_ID))
    .limit(1);

  const settingsRow = row[0];
  if (!settingsRow) {
    // Return defaults if settings don't exist yet
    return { externalUrl: null, basePath: '', trustProxy: false };
  }

  return {
    externalUrl: settingsRow.externalUrl,
    basePath: settingsRow.basePath,
    trustProxy: settingsRow.trustProxy,
  };
}
