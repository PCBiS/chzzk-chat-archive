import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolveExistingInside } from "./paths";

const ALLOWED_HOSTS = new Set(["nng-phinf.pstatic.net", "ssl.pstatic.net"]);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_URL_LENGTH = 512;
const MAX_NAME_LENGTH = 100;
const WEEK = 7 * 24 * 60 * 60_000;
const TOKEN = /\{:([^:{}\s]+):\}/g;

export type EmojiFetcher = (url: string, init: { redirect: "error"; signal: AbortSignal }) => Promise<Response>;

export interface EmojiSource {
  /** Rows after `afterId` in ascending id order; an empty array ends the scan. */
  rawRecordsAfter(afterId: number, limit: number): Array<{ id: number; raw: string }>;
}

interface EmojiRow {
  key: string;
  url: string;
  status: string;
  content_type: string | null;
}

export function allowedEmojiUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || url.port || url.username || url.password) return null;
  return url.href;
}

export function emojiKey(url: string) {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

function emojiEntries(extras: unknown): Array<[string, string]> {
  let value = extras;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  const emojis = (value as { emojis?: unknown } | null)?.emojis;
  if (!emojis || typeof emojis !== "object" || Array.isArray(emojis)) return [];
  const entries: Array<[string, string]> = [];
  for (const [name, raw] of Object.entries(emojis as Record<string, unknown>)) {
    if (name.length > MAX_NAME_LENGTH) continue;
    const url = allowedEmojiUrl(raw);
    if (url) entries.push([name, url]);
  }
  return entries;
}

function imageType(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/**
 * Local copy of the emoticon images referenced by archived chat records.
 * Images are keyed by their source URL, so a record keeps showing the image
 * it was sent with even after the streamer replaces or removes the emoticon.
 */
export class EmojiStore {
  private database!: DatabaseSync;
  private filesDir = "";
  private status = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private drainScheduled = false;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private maintenance: Promise<void> = Promise.resolve();
  private fetcher: EmojiFetcher;
  private fetchDelayMs: number;
  readonly networkEnabled: boolean;

  constructor(
    private dataDir: string,
    options: { fetcher?: EmojiFetcher; networkEnabled?: boolean; fetchDelayMs?: number } = {}
  ) {
    this.fetcher = options.fetcher || ((url, init) => fetch(url, init));
    this.networkEnabled = options.networkEnabled ?? true;
    this.fetchDelayMs = options.fetchDelayMs ?? 250;
  }

  async init() {
    const directory = path.join(this.dataDir, ".chzzk-emoji");
    await mkdir(path.join(directory, "files"), { recursive: true, mode: 0o700 });
    const safeDirectory = await resolveExistingInside(this.dataDir, ".chzzk-emoji");
    this.filesDir = await resolveExistingInside(this.dataDir, ".chzzk-emoji/files");
    this.database = new DatabaseSync(path.join(safeDirectory, "emoji.sqlite"));
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS emojis (
        key TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        content_type TEXT,
        bytes INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        fetched_at TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    for (const row of this.database.prepare("SELECT key, status FROM emojis").all() as Array<{ key: string; status: string }>) {
      this.status.set(row.key, row.status);
    }
  }

  private meta(name: string): string | undefined {
    return (this.database.prepare("SELECT value FROM meta WHERE name = ?").get(name) as { value: string } | undefined)?.value;
  }

  private setMeta(name: string, value: string) {
    this.database.prepare("INSERT INTO meta(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, value);
  }

  /** Remember emoticon URLs carried by a record. Never throws, never blocks on the network. */
  observe(extras: unknown) {
    if (this.stopped) return;
    let added = false;
    for (const [name, url] of emojiEntries(extras)) {
      const key = emojiKey(url);
      if (this.status.has(key)) continue;
      this.database.prepare("INSERT OR IGNORE INTO emojis(key, url, name, first_seen_at) VALUES (?, ?, ?, ?)")
        .run(key, url, name, new Date().toISOString());
      this.status.set(key, "pending");
      added = true;
    }
    if (added) this.scheduleDrain();
  }

  /** Emoticon name → stored image key, limited to tokens present in the message and already downloaded. */
  resolve(message: string, extras: unknown): Record<string, string> | undefined {
    if (!message.includes("{:")) return undefined;
    const entries = emojiEntries(extras);
    if (!entries.length) return undefined;
    const used = new Set([...message.matchAll(TOKEN)].map((match) => match[1]));
    const result: Record<string, string> = {};
    let found = false;
    for (const [name, url] of entries) {
      if (!used.has(name)) continue;
      const key = emojiKey(url);
      if (this.status.get(key) !== "ok") continue;
      result[name] = key;
      found = true;
    }
    return found ? result : undefined;
  }

  async file(key: unknown): Promise<{ path: string; contentType: string } | null> {
    if (typeof key !== "string" || !/^[0-9a-f]{32}$/.test(key)) return null;
    const row = this.database.prepare("SELECT key, url, status, content_type FROM emojis WHERE key = ?").get(key) as EmojiRow | undefined;
    if (!row || row.status !== "ok" || !row.content_type) return null;
    return { path: path.join(this.filesDir, row.key), contentType: row.content_type };
  }

  counts() {
    const rows = this.database.prepare("SELECT status, COUNT(*) AS count FROM emojis GROUP BY status").all() as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  private scheduleDrain() {
    if (!this.networkEnabled || this.drainScheduled || this.stopped) return;
    this.drainScheduled = true;
    this.queue = this.queue.then(async () => {
      this.drainScheduled = false;
      await this.drain();
    }).catch(() => {});
  }

  /** Download every pending image, one at a time. Calls are serialized. */
  fetchPending() {
    this.queue = this.queue.then(() => this.drain()).catch(() => {});
    return this.queue;
  }

  private async drain() {
    if (!this.networkEnabled) return;
    for (;;) {
      if (this.stopped) return;
      const rows = this.database.prepare("SELECT key, url, status, content_type FROM emojis WHERE status = 'pending' LIMIT 50").all() as unknown as EmojiRow[];
      if (!rows.length) return;
      for (const row of rows) {
        if (this.stopped) return;
        await this.download(row);
        if (this.fetchDelayMs) await new Promise((resolve) => setTimeout(resolve, this.fetchDelayMs));
      }
    }
  }

  private async download(row: EmojiRow) {
    let outcome = "failed";
    let contentType: string | null = null;
    let bytes: number | null = null;
    const temporary = path.join(this.filesDir, `.tmp-${randomUUID()}`);
    try {
      if (!allowedEmojiUrl(row.url)) throw new Error("disallowed");
      const response = await this.fetcher(row.url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("status");
      if (Number(response.headers.get("content-length") || 0) > MAX_BYTES) throw new Error("size");
      const chunks: Buffer[] = [];
      let received = 0;
      if (!response.body) throw new Error("body");
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        if (received > MAX_BYTES) throw new Error("size");
        chunks.push(Buffer.from(chunk));
      }
      const data = Buffer.concat(chunks);
      contentType = imageType(data);
      if (!contentType) throw new Error("type");
      await writeFile(temporary, data, { mode: 0o640, flag: "wx" });
      await rename(temporary, path.join(this.filesDir, row.key));
      bytes = data.length;
      outcome = "ok";
    } catch {
      await unlink(temporary).catch(() => {});
    }
    if (this.stopped && outcome !== "ok") return; // Interrupted by shutdown: leave pending for the next start.
    this.database.prepare(`UPDATE emojis SET status = ?, content_type = ?, bytes = ?, attempts = attempts + 1, fetched_at = ? WHERE key = ?`)
      .run(outcome, contentType, bytes, new Date().toISOString(), row.key);
    this.status.set(row.key, outcome);
  }

  /**
   * Weekly maintenance: pick up emoticons from records that were indexed
   * without passing through observe(), retry failed downloads and restore
   * images whose files went missing.
   */
  async refresh(source: EmojiSource) {
    let cursor = Number(this.meta("scan_cursor") || 0);
    for (;;) {
      if (this.stopped) return;
      const rows = source.rawRecordsAfter(cursor, 2000);
      if (!rows.length) break;
      for (const row of rows) {
        if (!row.raw.includes("pstatic.net")) continue;
        try { this.observe((JSON.parse(row.raw) as { extras?: unknown }).extras); } catch { /* skip unreadable rows */ }
      }
      cursor = rows[rows.length - 1].id;
      this.setMeta("scan_cursor", String(cursor));
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const row of this.database.prepare("SELECT key FROM emojis WHERE status = 'ok'").all() as Array<{ key: string }>) {
      const present = await stat(path.join(this.filesDir, row.key)).then((info) => info.isFile(), () => false);
      if (!present) {
        this.database.prepare("UPDATE emojis SET status = 'pending' WHERE key = ?").run(row.key);
        this.status.set(row.key, "pending");
      }
    }
    for (const row of this.database.prepare("SELECT key FROM emojis WHERE status = 'failed'").all() as Array<{ key: string }>) {
      this.status.set(row.key, "pending");
    }
    this.database.exec("UPDATE emojis SET status = 'pending' WHERE status = 'failed'");
    this.setMeta("last_refresh_at", String(Date.now()));
    await this.fetchPending();
  }

  /** Run refresh() shortly after startup when a week has passed, then keep checking hourly. */
  startSchedule(source: EmojiSource, onResult?: (error?: unknown) => void) {
    let running = false;
    const check = () => {
      if (running || this.stopped) return;
      if (Date.now() - Number(this.meta("last_refresh_at") || 0) < WEEK) return;
      running = true;
      this.maintenance = this.refresh(source).then(() => onResult?.(), (error) => onResult?.(error)).finally(() => { running = false; });
    };
    const first = setTimeout(check, 30_000);
    first.unref();
    this.timer = setInterval(check, 60 * 60_000);
    this.timer.unref();
    if (this.status.size && [...this.status.values()].includes("pending")) this.scheduleDrain();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.maintenance.catch(() => {});
    await this.queue.catch(() => {});
    this.database?.close();
  }
}
