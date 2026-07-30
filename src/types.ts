export interface StreamerConfig {
  channelId: string;
  name: string;
  enabled: boolean;
}

export interface CrawlerConfig {
  statusPollSeconds: number;
  scanStaggerSeconds: number;
  offChatLimitMinutes: number | null;
}

export type ArchiveKind = "live" | "off";

export interface ArchiveRecord {
  schemaVersion: 1;
  recordedAt: string;
  messageAt: string;
  streamer: {
    channelId: string;
    name: string;
  };
  broadcast: {
    sessionId: string;
    title: string;
    openedAt: string;
    kind: ArchiveKind;
  };
  event: "chat" | "donation" | "subscription" | "system";
  user: {
    id: string | null;
    nickname: string;
  };
  message: string;
  hidden: boolean;
  recent: boolean;
  extras?: unknown;
}

export interface WorkerSnapshot {
  channelId: string;
  name: string;
  enabled: boolean;
  broadcastStatus: "OPEN" | "CLOSE" | "UNKNOWN";
  archiveKind: ArchiveKind | null;
  connected: boolean;
  sessionId: string | null;
  file: string | null;
  lastError: string | null;
  updatedAt: string | null;
}
