/**
 * Notification dispatch service
 */

import type { ViolationWithDetails, ActiveSession, Settings } from '@tracearr/shared';
import { NOTIFICATION_EVENTS, RULE_DISPLAY_NAMES, SEVERITY_LEVELS } from '@tracearr/shared';

export interface NotificationPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export class NotificationService {
  /**
   * Send violation notification
   */
  async notifyViolation(
    violation: ViolationWithDetails,
    settings: Settings
  ): Promise<void> {
    if (!settings.notifyOnViolation) {
      return;
    }

    const payload = this.buildViolationPayload(violation);

    const promises: Promise<void>[] = [];

    if (settings.discordWebhookUrl) {
      promises.push(this.sendDiscord(settings.discordWebhookUrl, violation));
    }

    if (settings.customWebhookUrl) {
      promises.push(this.sendWebhook(settings.customWebhookUrl, payload));
    }

    await Promise.allSettled(promises);
  }

  /**
   * Send session started notification
   */
  async notifySessionStarted(session: ActiveSession, settings: Settings): Promise<void> {
    if (!settings.notifyOnSessionStart) {
      return;
    }

    const payload: NotificationPayload = {
      event: NOTIFICATION_EVENTS.STREAM_STARTED,
      timestamp: new Date().toISOString(),
      data: {
        user: { id: session.serverUserId, username: session.user.username },
        media: { title: session.mediaTitle, type: session.mediaType },
        location: { city: session.geoCity, country: session.geoCountry },
      },
    };

    if (settings.customWebhookUrl) {
      await this.sendWebhook(settings.customWebhookUrl, payload);
    }
  }

  /**
   * Send session stopped notification
   */
  async notifySessionStopped(session: ActiveSession, settings: Settings): Promise<void> {
    if (!settings.notifyOnSessionStop) {
      return;
    }

    const payload: NotificationPayload = {
      event: NOTIFICATION_EVENTS.STREAM_STOPPED,
      timestamp: new Date().toISOString(),
      data: {
        user: { id: session.serverUserId, username: session.user.username },
        media: { title: session.mediaTitle, type: session.mediaType },
        duration: session.durationMs,
      },
    };

    if (settings.customWebhookUrl) {
      await this.sendWebhook(settings.customWebhookUrl, payload);
    }
  }

  /**
   * Send server down notification
   */
  async notifyServerDown(serverName: string, settings: Settings): Promise<void> {
    if (!settings.notifyOnServerDown) {
      return;
    }

    const payload: NotificationPayload = {
      event: NOTIFICATION_EVENTS.SERVER_DOWN,
      timestamp: new Date().toISOString(),
      data: { serverName },
    };

    if (settings.discordWebhookUrl) {
      await this.sendDiscordMessage(settings.discordWebhookUrl, {
        title: 'Server Connection Lost',
        description: `Lost connection to ${serverName}`,
        color: 0xff0000,
      });
    }

    if (settings.customWebhookUrl) {
      await this.sendWebhook(settings.customWebhookUrl, payload);
    }
  }

  /**
   * Send server up notification
   */
  async notifyServerUp(serverName: string, settings: Settings): Promise<void> {
    if (!settings.notifyOnServerDown) {
      // Use same setting as server down for now
      return;
    }

    const payload: NotificationPayload = {
      event: NOTIFICATION_EVENTS.SERVER_UP,
      timestamp: new Date().toISOString(),
      data: { serverName },
    };

    if (settings.discordWebhookUrl) {
      await this.sendDiscordMessage(settings.discordWebhookUrl, {
        title: 'Server Back Online',
        description: `${serverName} is back online`,
        color: 0x2ecc71, // Green
      });
    }

    if (settings.customWebhookUrl) {
      await this.sendWebhook(settings.customWebhookUrl, payload);
    }
  }

  private buildViolationPayload(violation: ViolationWithDetails): NotificationPayload {
    return {
      event: NOTIFICATION_EVENTS.VIOLATION_DETECTED,
      timestamp: violation.createdAt.toISOString(),
      data: {
        user: { id: violation.serverUserId, username: violation.user.username },
        rule: { id: violation.ruleId, type: violation.rule.type, name: violation.rule.name },
        violation: { id: violation.id, severity: violation.severity, details: violation.data },
      },
    };
  }

  private async sendDiscord(webhookUrl: string, violation: ViolationWithDetails): Promise<void> {
    const severityColors = {
      low: 0x3498db,
      warning: 0xf39c12,
      high: 0xe74c3c,
    };

    const ruleType = violation.rule.type as keyof typeof RULE_DISPLAY_NAMES;
    const severity = violation.severity as keyof typeof SEVERITY_LEVELS;

    await this.sendDiscordMessage(webhookUrl, {
      title: `Sharing Violation Detected`,
      color: severityColors[severity],
      fields: [
        { name: 'User', value: violation.user.username, inline: true },
        { name: 'Rule', value: RULE_DISPLAY_NAMES[ruleType], inline: true },
        { name: 'Severity', value: SEVERITY_LEVELS[severity].label, inline: true },
        { name: 'Details', value: JSON.stringify(violation.data, null, 2) },
      ],
    });
  }

  private async sendDiscordMessage(
    webhookUrl: string,
    embed: { title: string; description?: string; color: number; fields?: unknown[] }
  ): Promise<void> {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            ...embed,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Discord webhook failed: ${response.status}`);
    }
  }

  private async sendWebhook(webhookUrl: string, payload: NotificationPayload): Promise<void> {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status}`);
    }
  }
}

export const notificationService = new NotificationService();
