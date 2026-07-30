import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import readline from "node:readline";
import { normalizeRelativePath, resolveExistingInside, resolveInside } from "./paths";

export type LogCategory = "system" | "crawler" | "auth" | "settings" | "files";
export type LogLevel = "info" | "warn" | "error";

export interface OperationalLogRecord {
  timestamp: string;
  localDate: string;
  level: LogLevel;
  category: LogCategory;
  event: string;
  message: string;
  details?: Record<string, unknown>;
}

const categories: LogCategory[] = ["system", "crawler", "auth", "settings", "files"];
const dayMs = 24 * 60 * 60_000;

export function koreanDate(value: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function assertLogFile(filePath: string) {
  if (!/\.jsonl(?:\.gz)?$/i.test(filePath)) {
    throw new Error("JSONL 또는 JSONL.GZ 로그 파일만 허용됩니다.");
  }
}

export class OperationalLogger {
  private writeChain: Promise<void> = Promise.resolve();
  private maintenanceTimer: NodeJS.Timeout | null = null;

  constructor(private root: string) {}

  async start() {
    await mkdir(this.root, { recursive: true });
    await Promise.all(categories.map((category) => mkdir(path.join(this.root, category), { recursive: true })));
    await this.rotate();
    this.maintenanceTimer = setInterval(() => void this.rotate(), 6 * 60 * 60_000);
    this.maintenanceTimer.unref();
  }

  async stop() {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    await this.writeChain;
  }

  log(
    category: LogCategory,
    level: LogLevel,
    event: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    const now = new Date();
    const localDate = koreanDate(now);
    const record: OperationalLogRecord = {
      timestamp: now.toISOString(),
      localDate,
      level,
      category,
      event,
      message,
      ...(details && Object.keys(details).length ? { details } : {})
    };
    const filePath = path.join(this.root, category, `${localDate}.jsonl`);
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o640 });
      })
      .catch((error) => console.error("[logger] write failed", error));
    return this.writeChain;
  }

  async rotate(now: Date = new Date()) {
    await this.writeChain;
    const today = koreanDate(now);
    const todayUtc = Date.parse(`${today}T00:00:00Z`);
    for (const category of categories) {
      const directory = path.join(this.root, category);
      await mkdir(directory, { recursive: true });
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry.name);
        if (!entry.isFile() || !match) continue;
        const fileUtc = Date.parse(`${match[1]}T00:00:00Z`);
        if (!Number.isFinite(fileUtc) || todayUtc - fileUtc <= 7 * dayMs) continue;
        const source = path.join(directory, entry.name);
        const target = `${source}.gz`;
        const temporary = `${target}.tmp`;
        try {
          await pipeline(createReadStream(source), createGzip({ level: 9 }), createWriteStream(temporary, { mode: 0o640 }));
          await rename(temporary, target);
          await unlink(source);
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          console.error(`[logger] rotation failed: ${source}`, error);
        }
      }
    }
  }
}

export async function listLogs(root: string, relativeInput: unknown) {
  const relative = normalizeRelativePath(relativeInput);
  const directory = await resolveExistingInside(root, relative);
  if (!(await stat(directory)).isDirectory()) throw new Error("폴더만 탐색할 수 있습니다.");
  const items = await Promise.all(
    (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink())
      .map(async (entry) => {
        const absolute = resolveInside(directory, entry.name);
        const info = await stat(absolute);
        return {
          name: entry.name,
          path: path.posix.join(relative, entry.name),
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? info.size : null,
          modifiedAt: info.mtime.toISOString()
        };
      })
  );
  return items
    .filter((item) => item.type === "directory" || /\.jsonl(?:\.gz)?$/i.test(item.name))
    .sort((a, b) => a.type.localeCompare(b.type) || b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function analyzeLog(
  root: string,
  relativeInput: unknown,
  options: { level?: string; query?: string; offset: number; limit: number }
) {
  const filePath = await resolveExistingInside(root, relativeInput);
  assertLogFile(filePath);
  if (!(await stat(filePath)).isFile()) throw new Error("파일이 아닙니다.");
  const source = createReadStream(filePath);
  const input = filePath.toLowerCase().endsWith(".gz") ? source.pipe(createGunzip()) : source;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const levelNeedle = options.level?.trim().toLowerCase() || "";
  const queryNeedle = options.query?.trim().toLocaleLowerCase("ko-KR") || "";
  const levels: Record<string, number> = {};
  const events: Record<string, number> = {};
  const records: OperationalLogRecord[] = [];
  let total = 0;
  let filtered = 0;
  let invalidLines = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record: OperationalLogRecord;
    try {
      record = JSON.parse(line) as OperationalLogRecord;
    } catch {
      invalidLines += 1;
      continue;
    }
    if (!record.timestamp || !record.level || !record.event || !record.message) {
      invalidLines += 1;
      continue;
    }
    total += 1;
    levels[record.level] = (levels[record.level] || 0) + 1;
    events[record.event] = (events[record.event] || 0) + 1;
    const haystack = `${record.category} ${record.event} ${record.message} ${JSON.stringify(record.details || {})}`
      .toLocaleLowerCase("ko-KR");
    if ((levelNeedle && record.level !== levelNeedle) || (queryNeedle && !haystack.includes(queryNeedle))) continue;
    if (filtered >= options.offset && records.length < options.limit) records.push(record);
    filtered += 1;
  }
  return {
    total,
    filtered,
    invalidLines,
    levels,
    events: Object.entries(events)
      .map(([event, count]) => ({ event, count }))
      .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event)),
    records
  };
}
