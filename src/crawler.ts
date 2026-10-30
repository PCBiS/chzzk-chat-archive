import path from "node:path";
import { lstat } from "node:fs/promises";
import { ChzzkClient } from "chzzk";
import { appendRecord } from "./archive";
import { safeSegment } from "./paths";
import { readRawSettings } from "./settings";
import type { OperationalLogger } from "./logs";
import type { ChatIndex } from "./chat-index";
import type { ArchiveStore } from "./archive-store";
import type { ArchiveKind, ArchiveRecord, StreamerConfig, WorkerSnapshot } from "./types";

interface Credentials {
  NID_AUT?: string;
  NID_SES?: string;
}

interface LiveStatus {
  status: "OPEN" | "CLOSE";
  chatChannelId?: string;
  liveTitle?: string;
}

interface LiveDetail extends LiveStatus {
  liveId?: number;
  openDate?: string;
}

interface ChatEvent {
  profile?: { nickname?: string; userIdHash?: string };
  message?: string;
  time?: number;
  hidden?: boolean;
  isRecent?: boolean;
  extras?: unknown;
}

type ChatConnection = {
  connected: boolean;
  chatChannelId?: string;
  on(event: string, handler: (payload: ChatEvent) => void): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  requestRecentChat(count?: number): void;
};

const ARCHIVE_TIME_ZONE = "Asia/Seoul";

function archiveDate(value: string | Date): Date {
  if (value instanceof Date) {
    return Number.isNaN(value.valueOf()) ? new Date() : value;
  }

  // CHZZK may return a local ISO timestamp without an explicit offset.
  // Treat that form as Korean local time instead of the container's timezone.
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value}+09:00`
    : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf()) ? new Date() : parsed;
}

export function formatArchiveTimestamp(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ARCHIVE_TIME_ZONE,
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(archiveDate(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";

  return `${part("year")}${part("month")}${part("day")}_${part("hour")}h${part("minute")}m${part("second")}s`;
}

export function archiveRelativePath(name: string, at: string | Date, kind: ArchiveKind): string {
  const streamerName = safeSegment(name);
  return path.posix.join(streamerName, `${formatArchiveTimestamp(at)}_${streamerName}_${kind}.jsonl`);
}

export function remainingScanDelay(lastScanStartedAt: number, scanStaggerMs: number, now = Date.now()): number {
  if (!lastScanStartedAt) return 0;
  return Math.max(0, lastScanStartedAt + scanStaggerMs - now);
}

export class StreamerWorker {
  private client: ChzzkClient;
  private chat: ChatConnection | null = null;
  private activeScan: Promise<void> | null = null;
  private checking = false;
  private stopped = false;
  private lastScanStartedAt = 0;
  private kind: ArchiveKind | null = null;
  private sessionId: string | null = null;
  private openedAt = "";
  private title = "";
  private currentFile: string | null = null;
  private offStartedAt = 0;
  private dedupe = new Map<string, number>();
  private snapshot: WorkerSnapshot;
  private writeQueue: Promise<void> = Promise.resolve();
  private sealQueue: Promise<void> = Promise.resolve();
  private sealedConfirmation: string | null = null;
  private activatedFiles = new Set<string>();

  constructor(
    private config: StreamerConfig,
    credentials: Credentials,
    private dataDir: string,
    private pollIntervalMs: number,
    private offChatLimitMs: number | null,
    private logger: OperationalLogger,
    private chatIndex: ChatIndex,
    lastScanStartedAt = 0,
    private archiveStore?: ArchiveStore
  ) {
    this.lastScanStartedAt = lastScanStartedAt;
    this.client = new ChzzkClient({
      nidAuth: credentials.NID_AUT || undefined,
      nidSession: credentials.NID_SES || undefined
    });
    this.snapshot = {
      channelId: config.channelId,
      name: config.name,
      enabled: config.enabled,
      broadcastStatus: "UNKNOWN",
      archiveKind: null,
      connected: false,
      sessionId: null,
      file: null,
      lastError: null,
      updatedAt: null
    };
  }

  isDue(now: number) {
    return this.config.enabled
      && !this.stopped
      && !this.checking
      && (this.lastScanStartedAt === 0 || now - this.lastScanStartedAt >= this.pollIntervalMs);
  }

  async scan() {
    const activeScan = this.tick();
    this.activeScan = activeScan;
    try {
      await activeScan;
    } finally {
      if (this.activeScan === activeScan) this.activeScan = null;
    }
  }

  async stop() {
    this.stopped = true;
    if (this.activeScan) await this.activeScan;
    await this.disconnect();
    await this.sealQueue;
  }

  getSnapshot(): WorkerSnapshot {
    return { ...this.snapshot, connected: Boolean(this.chat?.connected) };
  }

  getLastScanStartedAt() {
    return this.lastScanStartedAt;
  }

  private async tick() {
    if (this.checking || this.stopped || !this.config.enabled) return;
    this.checking = true;
    this.lastScanStartedAt = Date.now();
    const scanStartedAt = Date.now();
    void this.logger.log("crawler", "info", "scan_started", "스트리머 방송 상태 조회를 시작했습니다.", {
      channelId: this.config.channelId,
      streamer: this.config.name
    });
    try {
      const previousStatus = this.snapshot.broadcastStatus;
      const status = (await this.client.live.status(this.config.channelId)) as LiveStatus | null;
      this.snapshot.updatedAt = new Date().toISOString();
      this.snapshot.lastError = null;
      if (!status) {
        this.snapshot.broadcastStatus = "UNKNOWN";
        if (previousStatus !== "UNKNOWN") {
          void this.logger.log("crawler", "warn", "broadcast_status_changed", "방송 상태가 Unknown으로 변경되었습니다.", {
            channelId: this.config.channelId,
            streamer: this.config.name,
            from: previousStatus,
            to: "UNKNOWN"
          });
        }
        return;
      }
      this.snapshot.broadcastStatus = status.status;
      if (previousStatus !== status.status) {
        void this.logger.log("crawler", "info", "broadcast_status_changed", "방송 상태가 변경되었습니다.", {
          channelId: this.config.channelId,
          streamer: this.config.name,
          from: previousStatus,
          to: status.status
        });
      }
      if (status.status === "OPEN") {
        await this.handleOpen(status);
      } else {
        await this.handleClose(status);
      }
    } catch (error) {
      this.snapshot.lastError = error instanceof Error ? error.message : String(error);
      void this.logger.log("crawler", "error", "scan_failed", "방송 상태 조회에 실패했습니다.", {
        channelId: this.config.channelId,
        streamer: this.config.name,
        error: this.snapshot.lastError
      });
      console.error(`[crawler:${this.config.name}]`, error);
    } finally {
      void this.logger.log("crawler", "info", "scan_completed", "스트리머 방송 상태 조회를 마쳤습니다.", {
        channelId: this.config.channelId,
        streamer: this.config.name,
        status: this.snapshot.broadcastStatus,
        durationMs: Date.now() - scanStartedAt
      });
      this.checking = false;
    }
  }

  private async handleOpen(status: LiveStatus) {
    const detail = (await this.client.live.detail(this.config.channelId)) as LiveDetail | null;
    const openedAt = detail?.openDate || new Date().toISOString();
    const sessionId = String(detail?.liveId || status.chatChannelId || Date.parse(openedAt));
    const confirmed = typeof detail?.liveId === "number" && Number.isSafeInteger(detail.liveId) && detail.liveId > 0
      ? String(detail.liveId) : null;
    if (this.kind !== "live" || this.sessionId !== sessionId) {
      await this.disconnect();
      this.kind = "live";
      this.sessionId = sessionId;
      this.openedAt = openedAt;
      this.title = detail?.liveTitle || status.liveTitle || "";
      this.setFile("live", openedAt);
      void this.logger.log("crawler", "info", "live_archive_started", "라이브 채팅 파일 기록을 시작했습니다.", {
        channelId: this.config.channelId,
        streamer: this.config.name,
        sessionId,
        file: this.snapshot.file
      });
      await this.connect();
    } else if (!this.chat?.connected) {
      await this.connect();
    }
    // Connect first: checking legacy archives must never delay live collection.
    // An official ID without a valid opening time is insufficient evidence.
    const normalizedOpenDate = detail?.openDate?.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/, "$1T$2");
    const explicitOpenDate = normalizedOpenDate && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalizedOpenDate)
      ? `${normalizedOpenDate}+09:00` : normalizedOpenDate;
    const confirmedOpenAt = explicitOpenDate ? Date.parse(explicitOpenDate) : NaN;
    const confirmation = `${confirmed}:${confirmedOpenAt}`;
    if (this.archiveStore && confirmed && Number.isFinite(confirmedOpenAt) && confirmedOpenAt <= Date.now()
      && confirmation !== this.sealedConfirmation) {
      this.sealedConfirmation = confirmation;
      const previousWrites = this.writeQueue;
      this.sealQueue = this.sealQueue.then(async () => {
        await previousWrites;
        await this.archiveStore!.sealPriorCycles({
          channelId: this.config.channelId, sessionId: confirmed,
          openedAt: new Date(confirmedOpenAt).toISOString()
        });
        await compressEligibleArchives(this.archiveStore!, this.chatIndex);
      }).catch(async () => {
        if (this.sealedConfirmation === confirmation) this.sealedConfirmation = null;
        await this.logger.log("crawler", "warn", "archive_cycle_seal_failed", "이전 방송 완료 판정을 보류했습니다.", {
          channelId: this.config.channelId
        }).catch(() => {});
      });
    }
  }

  private async handleClose(status: LiveStatus) {
    if (this.kind === "live" && this.sessionId) {
      const offStartedAt = new Date();
      this.kind = "off";
      this.offStartedAt = offStartedAt.valueOf();
      this.setFile("off", offStartedAt);
      void this.logger.log("crawler", "info", "off_archive_started", "방종 후 채팅 파일 기록을 시작했습니다.", {
        channelId: this.config.channelId,
        streamer: this.config.name,
        sessionId: this.sessionId,
        file: this.snapshot.file
      });
    }
    if (
      this.kind === "off"
      && this.offChatLimitMs !== null
      && Date.now() - this.offStartedAt > this.offChatLimitMs
    ) {
      await this.disconnect();
      void this.logger.log("crawler", "info", "off_collection_stopped", "방종 후 채팅 수집 제한 시간이 종료되었습니다.", {
        channelId: this.config.channelId,
        streamer: this.config.name,
        sessionId: this.sessionId
      });
      this.kind = null;
      this.currentFile = null;
      this.updateSnapshot();
      return;
    }
    if (this.kind === "off" && !this.chat?.connected && status.chatChannelId) {
      await this.connect();
    }
  }

  private async connect() {
    if (!this.kind || !this.sessionId) return;
    const chat = this.client.chat({ channelId: this.config.channelId, pollInterval: this.pollIntervalMs }) as ChatConnection;
    this.chat = chat;
    chat.on("connect", () => {
      this.updateSnapshot();
      void this.logger.log("crawler", "info", "chat_connected", "채팅 서버에 연결했습니다.", {
        channelId: this.config.channelId,
        streamer: this.config.name,
        sessionId: this.sessionId,
        kind: this.kind
      });
      try {
        chat.requestRecentChat(50);
      } catch (error) {
        void this.logger.log("crawler", "warn", "recent_chat_failed", "최근 채팅 요청에 실패했습니다.", {
          channelId: this.config.channelId,
          streamer: this.config.name,
          error: error instanceof Error ? error.message : String(error)
        });
        console.warn(`[crawler:${this.config.name}] recent chat request failed`, error);
      }
    });
    const receive = (type: ArchiveRecord["event"]) => (event: ChatEvent) => {
      if (this.chat === chat && !this.stopped) void this.record(type, event);
    };
    chat.on("chat", receive("chat"));
    chat.on("donation", receive("donation"));
    chat.on("subscription", receive("subscription"));
    chat.on("systemMessage", receive("system"));
    await chat.connect();
    this.updateSnapshot();
  }

  private async disconnect() {
    const active = this.chat;
    this.chat = null;
    if (active?.connected) {
      try {
        await active.disconnect();
        void this.logger.log("crawler", "info", "chat_disconnected", "채팅 서버 연결을 종료했습니다.", {
          channelId: this.config.channelId,
          streamer: this.config.name,
          sessionId: this.sessionId
        });
      } catch (error) {
        void this.logger.log("crawler", "warn", "chat_disconnect_failed", "채팅 서버 연결 종료에 실패했습니다.", {
          channelId: this.config.channelId,
          streamer: this.config.name,
          error: error instanceof Error ? error.message : String(error)
        });
        console.warn(`[crawler:${this.config.name}] disconnect failed`, error);
      }
    }
    await this.writeQueue;
    this.updateSnapshot();
  }

  private async record(eventType: ArchiveRecord["event"], event: ChatEvent) {
    if (!this.currentFile || !this.kind || !this.sessionId) return;
    // Capture destination and broadcast metadata before any awaited operation.
    const currentFile = this.currentFile;
    const relativeFile = path.relative(this.dataDir, currentFile).replaceAll("\\", "/");
    const messageAt = new Date(event.time || Date.now()).toISOString();
    const nickname = event.profile?.nickname || (eventType === "system" ? "SYSTEM" : "익명");
    const dedupeKey = `${event.time || 0}:${event.profile?.userIdHash || nickname}:${event.message || ""}:${eventType}`;
    const now = Date.now();
    if (this.dedupe.has(dedupeKey)) return;
    this.dedupe.set(dedupeKey, now);
    if (this.dedupe.size > 5000) {
      for (const [key, timestamp] of this.dedupe) {
        if (now - timestamp > 10 * 60_000) this.dedupe.delete(key);
      }
    }
    const record: ArchiveRecord = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      messageAt,
      streamer: { channelId: this.config.channelId, name: this.config.name },
      broadcast: {
        sessionId: this.sessionId,
        title: this.title,
        openedAt: this.openedAt,
        kind: this.kind
      },
      event: eventType,
      user: { id: event.profile?.userIdHash || null, nickname },
      message: event.hidden ? "[블라인드 처리됨]" : event.message || "",
      hidden: Boolean(event.hidden),
      recent: Boolean(event.isRecent),
      ...(event.extras === undefined ? {} : { extras: event.extras })
    };
    const write = async () => {
    try {
      if (this.archiveStore && !this.activatedFiles.has(relativeFile)) {
        const previous = this.archiveStore.getState(relativeFile);
        if (previous && previous.state !== "ACTIVE") throw new Error("Refusing to reopen a sealed archive path");
        await this.archiveStore.registerActive(relativeFile, {
          channelId: record.streamer.channelId, sessionId: record.broadcast.sessionId, openedAt: record.broadcast.openedAt
        });
        this.activatedFiles.add(relativeFile);
      }
      const append = async () => {
        if (this.archiveStore) {
          if (this.archiveStore.getState(relativeFile)?.state !== "ACTIVE") throw new Error("Archive is no longer active; append refused");
          const compressedExists = await lstat(`${currentFile}.gz`).then(() => true, error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          });
          if (compressedExists) throw new Error("Compressed archive path exists; append refused");
        }
        await appendRecord(currentFile, record);
      try {
        this.chatIndex.addRecord(relativeFile, record);
      } catch (error) {
        void this.logger.log("crawler", "error", "chat_index_write_failed", "채팅 검색 인덱스 기록에 실패했습니다.", {
          channelId: this.config.channelId,
          streamer: this.config.name,
          file: relativeFile,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      };
      if (this.archiveStore) await this.archiveStore.withFile(relativeFile, append);
      else await append();
    } catch (error) {
      this.snapshot.lastError = error instanceof Error ? error.message : String(error);
      void this.logger.log("crawler", "error", "archive_write_failed", "채팅 아카이브 기록에 실패했습니다.", {
        channelId: this.config.channelId,
        streamer: this.config.name,
        file: relativeFile,
        error: this.snapshot.lastError
      });
      console.error(`[crawler:${this.config.name}] archive write failed`, error);
    }
    };
    const pending = this.writeQueue.then(write);
    this.writeQueue = pending.catch(() => {});
    await pending;
  }

  private setFile(kind: ArchiveKind, at: string | Date) {
    this.currentFile = path.join(this.dataDir, archiveRelativePath(this.config.name, at, kind));
    this.updateSnapshot();
  }

  private updateSnapshot() {
    this.snapshot.archiveKind = this.kind;
    this.snapshot.sessionId = this.sessionId;
    this.snapshot.file = this.currentFile ? path.relative(this.dataDir, this.currentFile).replaceAll("\\", "/") : null;
    this.snapshot.connected = Boolean(this.chat?.connected);
  }

}

export async function compressEligibleArchives(store: ArchiveStore, index: ChatIndex, now = Date.now()) {
  const results: Array<{ id: string; compressed: boolean; reason?: string }> = [];
  for (const state of store.listStates()) {
    if (state.state !== "CLOSED" || state.lastRecordAt === undefined || now - state.lastRecordAt < 7 * 24 * 60 * 60_000) continue;
    // syncFile and compress each acquire the shared lease themselves.
    // The cycle is already sealed, so no writer can append between them.
    try {
      await index.syncFile(state.id);
      results.push({ id: state.id, ...await store.compress(state.id, now) });
    } catch {
      // One damaged/unreadable archive must not prevent other files being processed.
      // Do not include raw paths, chat contents, or exception messages in logs.
      results.push({ id: state.id, compressed: false, reason: "archive_processing_failed" });
    }
  }
  return results;
}

export class CrawlerManager {
  private workers: StreamerWorker[] = [];
  private reloadChain: Promise<void> = Promise.resolve();
  private schedulerTimer: NodeJS.Timeout | null = null;
  private schedulerRunning = false;
  private schedulerGeneration = 0;
  private scanCursor = 0;
  private scanStaggerMs = 20_000;
  private lastGlobalScanStartedAt = 0;
  private scanHistory = new Map<string, number>();

  constructor(
    private configDir: string,
    private dataDir: string,
    private logger: OperationalLogger,
    private chatIndex: ChatIndex,
    private archiveStore?: ArchiveStore
  ) {}

  async start() {
    // Keep clone isolation effective after settings reload as well as startup.
    if (process.env.CRAWLER_DISABLED === "1") return;
    const { streamers, credentials, crawler } = await readRawSettings(this.configDir);
    const pollIntervalMs = crawler.statusPollSeconds * 1_000;
    this.scanStaggerMs = crawler.scanStaggerSeconds * 1_000;
    const offChatLimitMs = crawler.offChatLimitMinutes === null
      ? null
      : crawler.offChatLimitMinutes * 60_000;
    this.workers = streamers.map(
      (streamer) =>
        new StreamerWorker(
          streamer,
          credentials,
          this.dataDir,
          pollIntervalMs,
          offChatLimitMs,
          this.logger,
          this.chatIndex,
          this.scanHistory.get(streamer.channelId) || 0,
          this.archiveStore
        )
    );
    this.scanCursor = 0;
    this.schedulerRunning = true;
    const generation = ++this.schedulerGeneration;
    const firstScanDelay = remainingScanDelay(this.lastGlobalScanStartedAt, this.scanStaggerMs);
    this.scheduleNextScan(firstScanDelay, generation);
    const enabledCount = this.workers.filter((worker) => worker.getSnapshot().enabled).length;
    console.log(
      `[crawler] ${enabledCount} worker(s) enabled; status=${crawler.statusPollSeconds}s; stagger=${crawler.scanStaggerSeconds}s; off=${crawler.offChatLimitMinutes === null ? "unlimited" : `${crawler.offChatLimitMinutes}m`}`
    );
    void this.logger.log("system", "info", "crawler_started", "크롤러 스케줄러를 시작했습니다.", {
      enabledWorkers: enabledCount,
      statusPollSeconds: crawler.statusPollSeconds,
      scanStaggerSeconds: crawler.scanStaggerSeconds,
      offChatLimitMinutes: crawler.offChatLimitMinutes
    });
  }

  async stop() {
    this.schedulerRunning = false;
    this.schedulerGeneration += 1;
    if (this.schedulerTimer) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
    const stoppedWorkers = this.workers;
    await Promise.all(stoppedWorkers.map((worker) => worker.stop()));
    stoppedWorkers.forEach((worker) => {
      const snapshot = worker.getSnapshot();
      const lastScanStartedAt = worker.getLastScanStartedAt();
      if (lastScanStartedAt) this.scanHistory.set(snapshot.channelId, lastScanStartedAt);
    });
    this.workers = [];
    void this.logger.log("system", "info", "crawler_stopped", "크롤러 스케줄러를 중지했습니다.");
  }

  async reload() {
    this.reloadChain = this.reloadChain.then(async () => {
      await this.stop();
      await this.start();
      void this.logger.log("settings", "info", "crawler_reloaded", "저장된 설정으로 크롤러를 다시 불러왔습니다.");
    });
    return this.reloadChain;
  }

  snapshots() {
    return this.workers.map((worker) => worker.getSnapshot());
  }

  private scheduleNextScan(delayMs: number, generation: number) {
    if (!this.schedulerRunning || generation !== this.schedulerGeneration) return;
    this.schedulerTimer = setTimeout(() => void this.runScheduledScan(generation), delayMs);
  }

  private async runScheduledScan(generation: number) {
    if (!this.schedulerRunning || generation !== this.schedulerGeneration) return;
    const now = Date.now();
    const count = this.workers.length;
    let selected: StreamerWorker | undefined;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.scanCursor + offset) % count;
      const candidate = this.workers[index];
      if (candidate?.isDue(now)) {
        selected = candidate;
        this.scanCursor = (index + 1) % count;
        break;
      }
    }
    if (selected) {
      this.lastGlobalScanStartedAt = Date.now();
      await selected.scan();
      const snapshot = selected.getSnapshot();
      this.scanHistory.set(snapshot.channelId, selected.getLastScanStartedAt());
    }
    if (this.schedulerRunning && generation === this.schedulerGeneration) {
      this.scheduleNextScan(this.scanStaggerMs, generation);
    }
  }
}
