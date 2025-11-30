/**
 * Core type definitions for Tracearr
 */

// Server types
export type ServerType = 'plex' | 'jellyfin';

export interface Server {
  id: string;
  name: string;
  type: ServerType;
  url: string;
  createdAt: Date;
  updatedAt: Date;
}

// User types
export interface User {
  id: string;
  serverId: string;
  externalId: string;
  username: string;
  email: string | null;
  thumbUrl: string | null;
  isOwner: boolean;
  allowGuest: boolean;
  trustScore: number;
  createdAt: Date;
  updatedAt: Date;
}

export type UserRole = 'owner' | 'guest';

export interface AuthUser {
  userId: string;
  username: string;
  role: UserRole;
  serverIds: string[];
}

// Session types
export type SessionState = 'playing' | 'paused' | 'stopped';
export type MediaType = 'movie' | 'episode' | 'track';

export interface Session {
  id: string;
  serverId: string;
  userId: string;
  sessionKey: string;
  state: SessionState;
  mediaType: MediaType;
  mediaTitle: string;
  // Enhanced media metadata for episodes
  grandparentTitle: string | null; // Show name (for episodes)
  seasonNumber: number | null; // Season number (for episodes)
  episodeNumber: number | null; // Episode number (for episodes)
  year: number | null; // Release year
  thumbPath: string | null; // Poster path (e.g., /library/metadata/123/thumb)
  ratingKey: string | null; // Plex/Jellyfin media identifier
  externalSessionId: string | null; // External reference for deduplication
  startedAt: Date;
  stoppedAt: Date | null;
  durationMs: number | null; // Actual watch duration (excludes paused time)
  totalDurationMs: number | null; // Total media length
  progressMs: number | null; // Current playback position
  // Pause tracking - accumulates total paused time across pause/resume cycles
  lastPausedAt: Date | null; // When current pause started (null if not paused)
  pausedDurationMs: number; // Accumulated pause time in milliseconds
  // Session grouping for "resume where left off" tracking
  referenceId: string | null; // Links to first session in resume chain
  watched: boolean; // True if user watched 80%+ of content
  // Network and device info
  ipAddress: string;
  geoCity: string | null;
  geoRegion: string | null; // State/province/subdivision
  geoCountry: string | null;
  geoLat: number | null;
  geoLon: number | null;
  playerName: string | null; // Friendly device name
  deviceId: string | null; // Unique device identifier (machineIdentifier)
  product: string | null; // Product/app name (e.g., "Plex for iOS")
  device: string | null; // Device type (e.g., "iPhone")
  platform: string | null;
  quality: string | null;
  isTranscode: boolean;
  bitrate: number | null;
}

export interface ActiveSession extends Session {
  user: Pick<User, 'id' | 'username' | 'thumbUrl'>;
  server: Pick<Server, 'id' | 'name' | 'type'>;
}

// Session with user/server details (from paginated API)
// When returned from history queries, sessions are grouped by reference_id
export interface SessionWithDetails extends Omit<Session, 'ratingKey' | 'externalSessionId' | 'totalDurationMs'> {
  username: string;
  userThumb: string | null;
  serverName: string;
  serverType: ServerType;
  // Number of pause/resume segments in this grouped play (1 = no pauses)
  segmentCount?: number;
}

// Rule types
export type RuleType =
  | 'impossible_travel'
  | 'simultaneous_locations'
  | 'device_velocity'
  | 'concurrent_streams'
  | 'geo_restriction';

export interface ImpossibleTravelParams {
  maxSpeedKmh: number;
  ignoreVpnRanges?: boolean;
}

export interface SimultaneousLocationsParams {
  minDistanceKm: number;
}

export interface DeviceVelocityParams {
  maxIps: number;
  windowHours: number;
}

export interface ConcurrentStreamsParams {
  maxStreams: number;
}

export interface GeoRestrictionParams {
  blockedCountries: string[];
}

export type RuleParams =
  | ImpossibleTravelParams
  | SimultaneousLocationsParams
  | DeviceVelocityParams
  | ConcurrentStreamsParams
  | GeoRestrictionParams;

export interface Rule {
  id: string;
  name: string;
  type: RuleType;
  params: RuleParams;
  userId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Violation types
export type ViolationSeverity = 'low' | 'warning' | 'high';

export interface Violation {
  id: string;
  ruleId: string;
  userId: string;
  sessionId: string;
  severity: ViolationSeverity;
  data: Record<string, unknown>;
  createdAt: Date;
  acknowledgedAt: Date | null;
}

export interface ViolationWithDetails extends Violation {
  rule: Pick<Rule, 'id' | 'name' | 'type'>;
  user: Pick<User, 'id' | 'username' | 'thumbUrl'>;
}

// Stats types
export interface DashboardStats {
  activeStreams: number;
  todayPlays: number;
  watchTimeHours: number;
  alertsLast24h: number;
}

export interface PlayStats {
  date: string;
  count: number;
}

export interface UserStats {
  userId: string;
  username: string;
  thumbUrl: string | null;
  playCount: number;
  watchTimeHours: number;
}

export interface LocationUserInfo {
  id: string;
  username: string;
  thumbUrl: string | null;
}

export interface LocationStats {
  city: string | null;
  region: string | null; // State/province
  country: string | null;
  lat: number;
  lon: number;
  count: number;
  lastActivity?: Date;
  firstActivity?: Date;
  // Contextual data - populated based on filters
  users?: LocationUserInfo[]; // Top users at this location (when not filtering by userId)
  deviceCount?: number; // Unique devices from this location
}

export interface LocationStatsSummary {
  totalStreams: number;
  uniqueLocations: number;
  topCity: string | null;
}

export interface LocationFilterOptions {
  users: { id: string; username: string }[];
  servers: { id: string; name: string }[];
  mediaTypes: ('movie' | 'episode' | 'track')[];
}

export interface LocationStatsResponse {
  data: LocationStats[];
  summary: LocationStatsSummary;
  availableFilters: LocationFilterOptions;
}

export interface LibraryStats {
  movies: number;
  shows: number;
  episodes: number;
  tracks: number;
}

export interface DayOfWeekStats {
  day: number; // 0 = Sunday, 6 = Saturday
  name: string; // 'Sun', 'Mon', etc.
  count: number;
}

export interface HourOfDayStats {
  hour: number; // 0-23
  count: number;
}

export interface QualityStats {
  directPlay: number;
  transcode: number;
  total: number;
  directPlayPercent: number;
  transcodePercent: number;
}

export interface TopUserStats {
  userId: string;
  username: string;
  thumbUrl: string | null;
  serverId: string | null;
  trustScore: number;
  playCount: number;
  watchTimeHours: number;
  topMediaType: string | null; // "movie", "episode", etc.
  topContent: string | null; // Most watched show/movie name
}

export interface TopContentStats {
  title: string;
  type: string;
  showTitle: string | null; // For episodes, this is the show name
  year: number | null;
  playCount: number;
  watchTimeHours: number;
  thumbPath: string | null;
  serverId: string | null;
  ratingKey: string | null;
}

export interface PlatformStats {
  platform: string | null;
  count: number;
}

// Settings types
export interface Settings {
  allowGuestAccess: boolean;
  discordWebhookUrl: string | null;
  customWebhookUrl: string | null;
  notifyOnViolation: boolean;
  notifyOnSessionStart: boolean;
  notifyOnSessionStop: boolean;
  notifyOnServerDown: boolean;
  // Poller settings
  pollerEnabled: boolean;
  pollerIntervalMs: number;
  // Tautulli integration
  tautulliUrl: string | null;
  tautulliApiKey: string | null;
}

// Tautulli import types
export interface TautulliImportProgress {
  status: 'idle' | 'fetching' | 'processing' | 'complete' | 'error';
  totalRecords: number;
  processedRecords: number;
  importedRecords: number;
  skippedRecords: number;
  errorRecords: number;
  currentPage: number;
  totalPages: number;
  message: string;
}

export interface TautulliImportResult {
  success: boolean;
  imported: number;
  skipped: number;
  errors: number;
  message: string;
}

// WebSocket event types
export interface ServerToClientEvents {
  'session:started': (session: ActiveSession) => void;
  'session:stopped': (sessionId: string) => void;
  'session:updated': (session: ActiveSession) => void;
  'violation:new': (violation: ViolationWithDetails) => void;
  'stats:updated': (stats: DashboardStats) => void;
  'import:progress': (progress: TautulliImportProgress) => void;
}

export interface ClientToServerEvents {
  'subscribe:sessions': () => void;
  'unsubscribe:sessions': () => void;
}

// User location aggregation (derived from sessions)
export interface UserLocation {
  city: string | null;
  region: string | null; // State/province/subdivision
  country: string | null;
  lat: number | null;
  lon: number | null;
  sessionCount: number;
  lastSeenAt: Date;
  ipAddresses: string[];
}

// Device location summary (where a device has been used from)
export interface DeviceLocation {
  city: string | null;
  region: string | null;
  country: string | null;
  sessionCount: number;
  lastSeenAt: Date;
}

// User device aggregation (derived from sessions)
export interface UserDevice {
  deviceId: string | null;
  playerName: string | null;
  product: string | null;
  device: string | null;
  platform: string | null;
  sessionCount: number;
  lastSeenAt: Date;
  locations: DeviceLocation[]; // Where this device has been used from
}

// API response types
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
}
