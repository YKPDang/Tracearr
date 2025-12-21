#!/usr/bin/env tsx
/**
 * Debug script for Jellystat import dry run
 *
 * Usage: pnpm tsx apps/server/scripts/debug-jellystat-import.ts /path/to/backup.json
 */

import { readFileSync } from 'fs';
import { z } from 'zod';

// Import schema inline for portability
const jellystatPlayStateSchema = z.looseObject({
  IsPaused: z.boolean().nullable().optional(),
  IsMuted: z.boolean().nullable().optional(),
  VolumeLevel: z.number().nullable().optional(),
  RepeatMode: z.string().nullable().optional(),
  PlaybackOrder: z.string().nullable().optional(),
  PositionTicks: z.number().nullable().optional(),
  RuntimeTicks: z.number().nullable().optional(),
  PercentComplete: z.number().nullable().optional(),
  IsActive: z.boolean().nullable().optional(),
  Completed: z.boolean().nullable().optional(),
  CanSeek: z.boolean().nullable().optional(),
  IsStalled: z.boolean().nullable().optional(),
});

const jellystatTranscodingInfoSchema = z
  .looseObject({
    AudioCodec: z.string().nullable().optional(),
    VideoCodec: z.string().nullable().optional(),
    Container: z.string().nullable().optional(),
    IsVideoDirect: z.boolean().nullable().optional(),
    IsAudioDirect: z.boolean().nullable().optional(),
    Bitrate: z.number().nullable().optional(),
    CompletionPercentage: z.number().nullable().optional(),
    Width: z.number().nullable().optional(),
    Height: z.number().nullable().optional(),
    AudioChannels: z.number().nullable().optional(),
    HardwareAccelerationType: z.string().nullable().optional(),
    TranscodeReasons: z.array(z.string()).optional(),
  })
  .nullable()
  .optional();

const jellystatPlaybackActivitySchema = z.looseObject({
  Id: z.string(),
  UserId: z.string(),
  UserName: z.string().nullable().optional(),
  NowPlayingItemId: z.string(),
  NowPlayingItemName: z.string(),
  SeriesName: z.string().nullable().optional(),
  SeasonId: z.string().nullable().optional(),
  EpisodeId: z.string().nullable().optional(),
  PlaybackDuration: z.union([z.string(), z.number()]),
  ActivityDateInserted: z.string(),
  PlayMethod: z.string().nullable().optional(),
  PlayState: jellystatPlayStateSchema.nullable().optional(),
  TranscodingInfo: jellystatTranscodingInfoSchema,
  RemoteEndPoint: z.string().nullable().optional(),
  Client: z.string().nullable().optional(),
  DeviceName: z.string().nullable().optional(),
  DeviceId: z.string().nullable().optional(),
  IsPaused: z.boolean().nullable().optional(),
});

const jellystatBackupSchema = z.array(
  z.object({
    jf_playback_activity: z.array(jellystatPlaybackActivitySchema).optional(),
  })
);

type JellystatPlaybackActivity = z.infer<typeof jellystatPlaybackActivitySchema>;

const TICKS_TO_MS = 10000;

function parsePlayMethod(playMethod: string | null | undefined) {
  if (!playMethod) {
    return { videoDecision: 'directplay', audioDecision: 'directplay', isTranscode: false };
  }
  if (playMethod === 'DirectPlay') {
    return { videoDecision: 'directplay', audioDecision: 'directplay', isTranscode: false };
  }
  if (playMethod === 'DirectStream') {
    return { videoDecision: 'copy', audioDecision: 'copy', isTranscode: false };
  }
  if (playMethod.startsWith('Transcode')) {
    const match = playMethod.match(/\(v:(\w+)\s+a:(\w+)\)/);
    if (match) {
      const [, video, audio] = match;
      return {
        videoDecision: video === 'direct' ? 'copy' : 'transcode',
        audioDecision: audio === 'direct' ? 'copy' : 'transcode',
        isTranscode: true,
      };
    }
    return { videoDecision: 'transcode', audioDecision: 'transcode', isTranscode: true };
  }
  return { videoDecision: 'directplay', audioDecision: 'directplay', isTranscode: false };
}

function transformActivityToSession(
  activity: JellystatPlaybackActivity,
  serverId: string,
  serverUserId: string
) {
  const durationSeconds =
    typeof activity.PlaybackDuration === 'string'
      ? parseInt(activity.PlaybackDuration, 10)
      : activity.PlaybackDuration;
  const durationMs = isNaN(durationSeconds) ? 0 : durationSeconds * 1000;

  const stoppedAt = new Date(activity.ActivityDateInserted);
  const startedAt = new Date(stoppedAt.getTime() - durationMs);

  const positionMs =
    activity.PlayState?.PositionTicks != null
      ? Math.floor(activity.PlayState.PositionTicks / TICKS_TO_MS)
      : null;
  const totalDurationMs =
    activity.PlayState?.RuntimeTicks != null
      ? Math.floor(activity.PlayState.RuntimeTicks / TICKS_TO_MS)
      : null;

  const mediaType = activity.SeriesName ? 'episode' : 'movie';
  const { videoDecision, audioDecision, isTranscode } = parsePlayMethod(activity.PlayMethod);
  const bitrate = activity.TranscodingInfo?.Bitrate
    ? Math.floor(activity.TranscodingInfo.Bitrate / 1000)
    : null;

  return {
    serverId,
    serverUserId,
    sessionKey: activity.Id,
    plexSessionId: null,
    ratingKey: activity.NowPlayingItemId,
    externalSessionId: activity.Id,
    referenceId: null,
    state: 'stopped',
    mediaType,
    mediaTitle: activity.NowPlayingItemName,
    grandparentTitle: activity.SeriesName ?? null,
    seasonNumber: null,
    episodeNumber: null,
    year: null,
    thumbPath: null,
    startedAt,
    lastSeenAt: stoppedAt,
    lastPausedAt: null,
    stoppedAt,
    durationMs,
    totalDurationMs,
    progressMs: positionMs,
    pausedDurationMs: 0,
    watched: activity.PlayState?.Completed ?? false,
    forceStopped: false,
    shortSession: durationMs < 120000,
    ipAddress: activity.RemoteEndPoint ?? '0.0.0.0',
    geoCity: null,
    geoRegion: null,
    geoCountry: null,
    geoLat: null,
    geoLon: null,
    playerName: activity.DeviceName ?? activity.Client ?? 'Unknown',
    device: activity.DeviceName ?? activity.Client ?? null,
    deviceId: activity.DeviceId ?? null,
    product: activity.Client ?? null,
    platform: activity.Client ?? null,
    quality: null,
    isTranscode,
    videoDecision,
    audioDecision,
    bitrate,
  };
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(
      'Usage: pnpm tsx apps/server/scripts/debug-jellystat-import.ts /path/to/backup.json'
    );
    process.exit(1);
  }

  console.log(`\n📂 Reading file: ${filePath}\n`);

  const jsonString = readFileSync(filePath, 'utf-8');
  console.log(`📊 File size: ${(jsonString.length / 1024 / 1024).toFixed(2)} MB`);

  // Parse the backup
  console.log('\n🔍 Parsing backup file...');
  const data: unknown = JSON.parse(jsonString);
  const parsed = jellystatBackupSchema.safeParse(data);

  if (!parsed.success) {
    console.error('\n❌ Schema validation failed. Showing first 5 errors:');
    const issues = parsed.error.issues || [];
    const errors = issues.slice(0, 5);
    for (const err of errors) {
      console.error(`\nPath: ${err.path.join('.')}`);
      console.error(`Message: ${err.message}`);
      console.error(`Code: ${err.code}`);

      // Try to find the actual record that failed
      if (err.path.length >= 3) {
        const sectionIdx = err.path[0] as number;
        const field = err.path[1] as string;
        const recordIdx = err.path[2] as number;

        const rawData = data as Array<Record<string, unknown[]>>;
        if (rawData[sectionIdx]?.[field]?.[recordIdx]) {
          const record = rawData[sectionIdx][field][recordIdx] as Record<string, unknown>;
          console.error('\nRecord that failed:');
          console.error(`  Id: ${record.Id}`);
          console.error(`  PlayMethod: ${JSON.stringify(record.PlayMethod)}`);
          console.error(`  NowPlayingItemName: ${record.NowPlayingItemName}`);
        }
      }
    }
    console.log(`\nTotal validation errors: ${issues.length}`);

    // Continue anyway with loose parsing
    console.log('\n⚠️  Attempting loose parse to continue analysis...\n');
  }

  // Use raw data if validation failed
  const rawData = data as Array<Record<string, unknown[]>>;
  const playbackSection = rawData.find(
    (section): section is { jf_playback_activity: JellystatPlaybackActivity[] } =>
      'jf_playback_activity' in section
  );
  const activities = (playbackSection?.jf_playback_activity ?? []) as JellystatPlaybackActivity[];

  console.log(`✅ Parsed ${activities.length} playback activity records\n`);

  // Show backup structure
  console.log('📋 Backup sections:');
  for (const section of rawData) {
    const keys = Object.keys(section);
    for (const key of keys) {
      const arr = (section as Record<string, unknown[]>)[key];
      console.log(`   - ${key}: ${Array.isArray(arr) ? arr.length : 'N/A'} records`);
    }
  }

  if (activities.length === 0) {
    console.log('\n⚠️  No playback activity found in backup');
    process.exit(0);
  }

  // Sample some records
  const sampleSize = Math.min(5, activities.length);
  console.log(`\n🔬 Analyzing first ${sampleSize} records...\n`);

  const fakeServerId = '00000000-0000-0000-0000-000000000001';
  const fakeServerUserId = '00000000-0000-0000-0000-000000000002';

  // Track field value issues
  const issues: string[] = [];
  const fieldLengths = new Map<string, { max: number; sample: string }>();

  for (let i = 0; i < sampleSize; i++) {
    const activity = activities[i];
    console.log(`\n━━━ Record ${i + 1} ━━━`);
    console.log(`ID: ${activity.Id}`);
    console.log(`User: ${activity.UserId} (${activity.UserName ?? 'no username'})`);
    console.log(`Media: ${activity.NowPlayingItemName}`);
    console.log(`Series: ${activity.SeriesName ?? 'N/A'}`);
    console.log(`Duration: ${activity.PlaybackDuration}s`);
    console.log(`Date: ${activity.ActivityDateInserted}`);
    console.log(`PlayMethod: ${activity.PlayMethod}`);
    console.log(`RemoteEndPoint: ${activity.RemoteEndPoint ?? 'null'}`);
    console.log(`Device: ${activity.DeviceName} / ${activity.Client}`);
    console.log(
      `DeviceId: ${activity.DeviceId?.substring(0, 50)}${activity.DeviceId && activity.DeviceId.length > 50 ? '...' : ''}`
    );

    // Transform and validate
    const session = transformActivityToSession(activity, fakeServerId, fakeServerUserId);

    // Check for potential issues
    if (session.deviceId && session.deviceId.length > 255) {
      issues.push(`Record ${activity.Id}: deviceId length ${session.deviceId.length} exceeds 255`);
    }
    if (session.playerName && session.playerName.length > 255) {
      issues.push(
        `Record ${activity.Id}: playerName length ${session.playerName.length} exceeds 255`
      );
    }
    if (session.mediaTitle && session.mediaTitle.length > 1000) {
      issues.push(
        `Record ${activity.Id}: mediaTitle length ${session.mediaTitle.length} is very long`
      );
    }

    // Track max lengths for string fields
    for (const [key, value] of Object.entries(session)) {
      if (typeof value === 'string') {
        const existing = fieldLengths.get(key);
        if (!existing || value.length > existing.max) {
          fieldLengths.set(key, { max: value.length, sample: value.substring(0, 100) });
        }
      }
    }
  }

  // Scan all records for field length issues
  console.log('\n🔎 Scanning all records for potential issues...');
  let recordsWithLongDeviceId = 0;
  let maxDeviceIdLength = 0;
  let recordsWithLongSessionKey = 0;
  let maxSessionKeyLength = 0;
  const longDeviceIdRecords: { id: string; len: number; deviceId: string }[] = [];

  for (const activity of activities) {
    if (activity.DeviceId) {
      if (activity.DeviceId.length > maxDeviceIdLength) {
        maxDeviceIdLength = activity.DeviceId.length;
      }
      if (activity.DeviceId.length > 255) {
        recordsWithLongDeviceId++;
        if (longDeviceIdRecords.length < 5) {
          longDeviceIdRecords.push({
            id: activity.Id,
            len: activity.DeviceId.length,
            deviceId: activity.DeviceId.substring(0, 80) + '...',
          });
        }
      }
    }
    if (activity.Id) {
      if (activity.Id.length > maxSessionKeyLength) {
        maxSessionKeyLength = activity.Id.length;
      }
      if (activity.Id.length > 255) {
        recordsWithLongSessionKey++;
      }
    }
  }

  console.log(`\n📏 Field length analysis (max across all records):`);
  console.log(
    `   - DeviceId: max ${maxDeviceIdLength} chars (${recordsWithLongDeviceId} exceed 255)`
  );
  console.log(
    `   - SessionKey/Id: max ${maxSessionKeyLength} chars (${recordsWithLongSessionKey} exceed 255)`
  );

  if (longDeviceIdRecords.length > 0) {
    console.log(`\n🚨 Records with deviceId > 255 chars:`);
    for (const rec of longDeviceIdRecords) {
      console.log(`   Record ${rec.id}: ${rec.len} chars`);
      console.log(`      DeviceId: ${rec.deviceId}`);
    }
  }

  // Show unique users
  const userIds = new Set(activities.map((a) => a.UserId));
  console.log(`\n👥 Unique users: ${userIds.size}`);
  console.log(
    '   User IDs:',
    [...userIds].slice(0, 10).join(', '),
    userIds.size > 10 ? `... (+${userIds.size - 10} more)` : ''
  );

  // Show unique devices
  const devices = new Set(activities.map((a) => a.DeviceName).filter(Boolean));
  console.log(`\n📱 Unique devices: ${devices.size}`);

  // Test transform on first record
  console.log('\n🔧 Sample transformed session object:');
  const sampleSession = transformActivityToSession(activities[0], fakeServerId, fakeServerUserId);
  console.log(JSON.stringify(sampleSession, null, 2));

  // Count columns
  const columnNames = Object.keys(sampleSession);
  console.log(`\n📊 Session insert has ${columnNames.length} columns:`);
  console.log('   ' + columnNames.join(', '));

  // Check for any undefined or problematic values
  console.log('\n⚠️  Checking for potential data issues...');
  let nullValuesInNotNullFields = 0;
  const notNullFields = [
    'serverId',
    'serverUserId',
    'sessionKey',
    'state',
    'mediaType',
    'mediaTitle',
    'startedAt',
    'lastSeenAt',
    'ipAddress',
  ];

  for (const activity of activities.slice(0, 100)) {
    const session = transformActivityToSession(activity, fakeServerId, fakeServerUserId);
    for (const field of notNullFields) {
      const value = session[field as keyof typeof session];
      if (value === null || value === undefined) {
        nullValuesInNotNullFields++;
        if (nullValuesInNotNullFields <= 5) {
          console.log(`   Record ${activity.Id}: ${field} is ${value}`);
        }
      }
    }
  }

  if (nullValuesInNotNullFields > 5) {
    console.log(`   ... and ${nullValuesInNotNullFields - 5} more NOT NULL violations`);
  } else if (nullValuesInNotNullFields === 0) {
    console.log('   ✅ No NOT NULL violations detected in first 100 records');
  }

  if (issues.length > 0) {
    console.log('\n⚠️  Potential issues found:');
    for (const issue of issues) {
      console.log(`   - ${issue}`);
    }
  }

  console.log('\n✅ Dry run complete!\n');
}

main().catch(console.error);
