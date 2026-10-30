import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, open, link, unlink, readdir } from "node:fs/promises";
import readline from "node:readline";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { assertPublicArchivePath, resolveExistingInside } from "./paths";

export interface ArchiveRef {
  logicalPath: string;
  physicalPath: string;
  encoding: "plain" | "gzip";
  rawBytes: number;
  sha256?: string;
  state: string;
}

export interface ArchiveGeneration {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface ArchiveState {
  id: string;
  state: string;
  channelId?: string;
  sessionId?: string;
  successorId?: string;
  openedAt?: string;
  lastRecordAt?: number;
  rawBytes?: number;
  sha256?: string;
  tmp?: string;
  updatedAt: number;
  reason?: string;
  generation?: ArchiveGeneration;
}

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

export function parseBroadcastTimestamp(value: string | undefined): number {
  if (!value) return NaN;
  const normalized = value.replace(" ", "T");
  return Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized) ? `${normalized}+09:00` : normalized);
}

export interface ConfirmedCycle { channelId: string; sessionId: string; openedAt: string; }

// All application readers/writers must share this
// instance and its leases; this is not an inter-process advisory lock.
export class ArchiveStore {
  private database!: DatabaseSync;
  private chains = new Map<string, Promise<void>>();
  private compressionTail: Promise<void> = Promise.resolve();

  constructor(private dataDir: string) {}

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    const directory = path.join(this.dataDir, ".chzzk-archive");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const safeDirectory = await resolveExistingInside(this.dataDir, ".chzzk-archive");
    const databaseId = ".chzzk-archive/state.sqlite";
    await this.exists(databaseId); // Reject an existing database symlink outside dataDir.
    // The database contains lifecycle metadata only, never chat bodies.
    this.database = new DatabaseSync(path.join(safeDirectory, "state.sqlite"));
    const version = (this.database.prepare("PRAGMA user_version").get() as {user_version: number}).user_version;
    if (version > 1) { this.database.close(); throw new Error(`Unsupported archive metadata version ${version}`); }
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS confirmed_cycles(channel_id TEXT PRIMARY KEY, metadata TEXT NOT NULL);`);
    if (version === 0) this.database.exec("PRAGMA user_version=1");
    await this.syncDirectory(path.join(safeDirectory, "state.sqlite"));
    await this.syncFile(path.resolve(this.dataDir));
  }

  close() { this.database?.close(); }

  private logical(input: string) {
    const id = assertPublicArchivePath(input);
    if (!id || !id.endsWith(".jsonl")) throw new Error("Expected logical JSONL archive path");
    return id;
  }

  getState(input: string): ArchiveState | undefined {
    const id = this.logical(input);
    const row = this.database.prepare("SELECT metadata FROM archives WHERE id=?").get(id) as { metadata: string } | undefined;
    return row ? JSON.parse(row.metadata) as ArchiveState : undefined;
  }

  listStates(): ArchiveState[] {
    const rows = this.database.prepare("SELECT metadata FROM archives ORDER BY id").all() as Array<{metadata: string}>;
    return rows.map(row => JSON.parse(row.metadata) as ArchiveState);
  }

  private async generation(filename: string): Promise<ArchiveGeneration> {
    const info = await stat(filename);
    return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
  }

  private sameGeneration(left: ArchiveGeneration | undefined, right: ArchiveGeneration) {
    return !!left && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
  }

  private save(value: ArchiveState) {
    value.updatedAt = Date.now();
    this.database.prepare("INSERT INTO archives(id,metadata) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata")
      .run(value.id, JSON.stringify(value));
  }

  async withFile<T>(input: string, fn: () => Promise<T>): Promise<T> {
    const id = this.logical(input);
    const previous = this.chains.get(id) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.chains.set(id, tail);
    await previous;
    try { return await fn(); }
    finally {
      release();
      if (this.chains.get(id) === tail) this.chains.delete(id);
    }
  }

  private async exists(id: string): Promise<string | undefined> {
    try { return await resolveExistingInside(this.dataDir, id); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async resolve(input: string): Promise<ArchiveRef> {
    const id = this.logical(input);
    const state = this.getState(id);
    if (state && ["QUARANTINED", "PENDING_REVALIDATION", "DELETING", "DELETED"].includes(state.state)) {
      throw new Error(`Archive unavailable: ${state.state}`);
    }
    const plain = await this.exists(id);
    if (plain) return { logicalPath: id, physicalPath: plain, encoding: "plain", rawBytes: (await stat(plain)).size, state: state?.state || "UNKNOWN" };
    const gzip = await this.exists(`${id}.gz`);
    if (gzip && state?.sha256 && state.rawBytes !== undefined && ["COMPRESSED", "GZIP_COMMITTED"].includes(state.state)) {
      // A cheap stat only: browsing/search must never decompress the archive.
      if (!this.sameGeneration(state.generation, await this.generation(gzip))) {
        this.save({ ...state, state: "PENDING_REVALIDATION", reason: "gzip_generation_changed" });
        throw new Error("Compressed archive changed; explicit integrity revalidation required");
      }
      return { logicalPath: id, physicalPath: gzip, encoding: "gzip", rawBytes: state.rawBytes, sha256: state.sha256, state: state.state };
    }
    throw new Error("Archive missing or compressed archive lacks verified metadata");
  }

  async registerActive(input: string, context?: {channelId: string; sessionId: string; openedAt?: string}) {
    const id = this.logical(input);
    await this.withFile(id, async () => {
      const previous = this.getState(id);
      if (await this.exists(`${id}.gz`) || previous && previous.state !== "ACTIVE") {
        throw new Error("Cannot append to a compressed, pending, deleted, or quarantined archive");
      }
      if (context && (!context.channelId || !context.sessionId)) throw new Error("Invalid active archive context");
      if (previous?.channelId && context && (previous.channelId !== context.channelId || previous.sessionId !== context.sessionId)) {
        throw new Error("Archive identity changed; append refused");
      }
      this.save({ ...previous, ...context, id, state: "ACTIVE", updatedAt: Date.now() });
    });
  }

  async registerClosed(input: string, opts: {channelId: string; sessionId: string; successorId: string; lastRecordAt: number}) {
    const id = this.logical(input);
    if (!opts.channelId || !opts.sessionId || !opts.successorId || opts.sessionId === opts.successorId || !Number.isFinite(opts.lastRecordAt)) {
      throw new Error("A confirmed distinct successor and last record time are required");
    }
    await this.withFile(id, async () => {
      const previous = this.getState(id);
      if (previous && !["ACTIVE", "CLOSED"].includes(previous.state)) throw new Error("Invalid close transition");
      if (!await this.exists(id) || await this.exists(`${id}.gz`)) throw new Error("Closed archive must have only its plain source");
      const source = await this.exists(id);
      const info = await stat(source!);
      this.save({ ...previous, id, state: "CLOSED", ...opts, lastRecordAt: Math.max(opts.lastRecordAt, info.mtimeMs), updatedAt: Date.now() });
    });
  }

  readConfirmedCycle(channelId: string): ConfirmedCycle | undefined {
    const row = this.database.prepare("SELECT metadata FROM confirmed_cycles WHERE channel_id=?").get(channelId) as {metadata: string} | undefined;
    return row ? JSON.parse(row.metadata) as ConfirmedCycle : undefined;
  }

  // The caller must supply official liveId/openDate values, never reconnect fallbacks.
  async sealPriorCycles(cycle: ConfirmedCycle): Promise<string[]> {
    const opened = parseBroadcastTimestamp(cycle.openedAt);
    const observedAt = Date.now();
    if (!cycle.channelId || !cycle.sessionId || !Number.isFinite(opened) || opened > Date.now()) {
      throw new Error("Confirmed channel, session and past opening time are required");
    }
    const previous = this.readConfirmedCycle(cycle.channelId);
    if (previous && (opened < parseBroadcastTimestamp(previous.openedAt) ||
      (opened === parseBroadcastTimestamp(previous.openedAt) && previous.sessionId !== cycle.sessionId))) return [];
    this.database.prepare("INSERT INTO confirmed_cycles(channel_id,metadata) VALUES (?,?) ON CONFLICT(channel_id) DO UPDATE SET metadata=excluded.metadata")
      .run(cycle.channelId, JSON.stringify(cycle));
    const ids: string[] = [];
    const visit = async (directory: string, relative = "") => {
      for (const entry of await readdir(directory, {withFileTypes: true})) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const id = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await visit(path.join(directory, entry.name), id);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) ids.push(id);
      }
    };
    await visit(this.dataDir);
    const sealed: string[] = [];
    for (const id of ids) {
      await this.withFile(id, async () => {
        const known = this.getState(id);
        if (known && (known.state !== "ACTIVE" || (known.channelId && known.channelId !== cycle.channelId) ||
          known.sessionId === cycle.sessionId)) return;
        const source = await this.exists(id);
        if (!source || await this.exists(`${id}.gz`)) return;
        const before = await this.generation(source);
        if (!before.size || before.mtimeMs > observedAt) return;
        // Require a newline-terminated file: a partial final append is never sealed.
        const handle = await open(source, "r");
        try {
          const tail = Buffer.alloc(1);
          await handle.read(tail, 0, 1, before.size - 1);
          if (tail[0] !== 10) return;
        } finally { await handle.close(); }
        let identity: {sessionId: string; openedAt: string} | undefined;
        let lastRecordAt = before.mtimeMs;
        let invalid = false;
        const input = createReadStream(source, {encoding: "utf8"});
        const lines = readline.createInterface({input, crlfDelay: Infinity});
        try {
          for await (const line of lines) {
            if (!line.trim()) { invalid = true; break; }
            let record;
            try { record = JSON.parse(line); } catch { invalid = true; break; }
            const recordTime = Date.parse(record.recordedAt);
            const recordOpen = parseBroadcastTimestamp(record.broadcast?.openedAt);
            if (record.schemaVersion !== 1 || record.streamer?.channelId !== cycle.channelId ||
              typeof record.broadcast?.sessionId !== "string" || !record.broadcast.sessionId ||
              !["live", "off"].includes(record.broadcast.kind) || typeof record.message !== "string" || !record.user ||
              !Number.isFinite(recordTime) || !Number.isFinite(recordOpen) ||
              recordTime < recordOpen || recordTime > observedAt || recordOpen >= opened ||
              record.broadcast.sessionId === cycle.sessionId) { invalid = true; break; }
            if (identity && (identity.sessionId !== record.broadcast.sessionId || parseBroadcastTimestamp(identity.openedAt) !== recordOpen)) {
              invalid = true; break;
            }
            identity = {sessionId: record.broadcast.sessionId, openedAt: record.broadcast.openedAt};
            lastRecordAt = Math.max(lastRecordAt, recordTime);
          }
        } finally { lines.close(); input.destroy(); }
        if (invalid || !identity || (known?.sessionId && known.sessionId !== identity.sessionId) ||
          (known?.openedAt && parseBroadcastTimestamp(known.openedAt) !== parseBroadcastTimestamp(identity.openedAt)) ||
          !this.sameGeneration(before, await this.generation(source))) return;
        // A concurrent newer confirmation takes precedence over this scan.
        const latest = this.readConfirmedCycle(cycle.channelId);
        if (latest?.sessionId !== cycle.sessionId || parseBroadcastTimestamp(latest.openedAt) !== opened) return;
        this.save({id, state: "CLOSED", channelId: cycle.channelId, ...identity,
          successorId: cycle.sessionId, lastRecordAt, updatedAt: Date.now()});
        sealed.push(id);
      });
    }
    return sealed;
  }

  // Generation changes require an explicit full read; normal browsing never does it.
  async revalidate(input: string): Promise<void> {
    const id = this.logical(input);
    await this.withFile(id, async () => {
      const state = this.getState(id);
      if (!state || !["COMPRESSED", "PENDING_REVALIDATION"].includes(state.state) || !state.sha256 || state.rawBytes === undefined) {
        throw new Error("Archive has no revalidatable compressed metadata");
      }
      const filename = await this.exists(`${id}.gz`);
      if (!filename || await this.exists(id)) throw new Error("Ambiguous or absent compressed archive");
      try {
        const before = await this.generation(filename);
        const actual = await this.digest(filename, true);
        if (actual.sha256 !== state.sha256 || actual.rawBytes !== state.rawBytes ||
          !this.sameGeneration(before, await this.generation(filename))) throw new Error("gzip_integrity_mismatch");
        this.save({...state, state: "COMPRESSED", generation: before, reason: undefined});
      } catch {
        this.save({...state, state: "QUARANTINED", reason: "gzip_revalidation_failed"});
        throw new Error("Compressed archive failed revalidation; preserved for inspection");
      }
    });
  }

  private ownsTemporary(id: string, temporary: string) {
    const prefix = `${id}.gz.`;
    return temporary.startsWith(prefix) && /^[0-9a-f-]{36}\.tmp$/.test(temporary.slice(prefix.length));
  }

  private async digest(filename: string, gzip = false) {
    const hash = createHash("sha256");
    let bytes = 0;
    const input = createReadStream(filename);
    const stream = gzip ? input.pipe(createGunzip()) : input;
    if (gzip) input.on("error", error => stream.destroy(error));
    for await (const chunk of stream) {
      hash.update(chunk);
      bytes += (chunk as Buffer).length;
    }
    return { sha256: hash.digest("hex"), rawBytes: bytes };
  }

  private async syncFile(filename: string) {
    const handle = await open(filename, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async syncDirectory(filename: string) { await this.syncFile(path.dirname(filename)); }

  private fault(failAt: string | undefined, phase: string) {
    if (failAt === phase) throw new Error(`SIMULATED_CRASH:${phase}`);
    if (failAt === `enospc_${phase}`) throw Object.assign(new Error("SIMULATED_ENOSPC"), { code: "ENOSPC" });
  }

  async compress(input: string, now = Date.now(), failAt?: string): Promise<{compressed: boolean; reason?: string}> {
    const id = this.logical(input);
    let release!: () => void;
    const previous = this.compressionTail;
    this.compressionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await this.withFile(id, async () => {
        const state = this.getState(id);
        if (!state || state.state !== "CLOSED") return { compressed: false, reason: "not_closed" };
        if (!state.successorId || !state.sessionId || state.successorId === state.sessionId) return { compressed: false, reason: "no_successor" };
        if (state.lastRecordAt === undefined || now - state.lastRecordAt < SEVEN_DAYS) return { compressed: false, reason: "younger_than_7_days" };
        const source = await resolveExistingInside(this.dataDir, id);
        const before = await stat(source);
        if (!before.isFile()) throw new Error("Source is not a regular file");
        if (now - before.mtimeMs < SEVEN_DAYS) return { compressed: false, reason: "source_younger_than_7_days" };
        if (await this.exists(`${id}.gz`)) {
          this.save({ ...state, state: "QUARANTINED", reason: "gzip_already_exists" });
          throw new Error("Refusing to overwrite existing gzip");
        }
        const tmpId = `${id}.gz.${randomUUID()}.tmp`;
        const tmp = path.join(path.dirname(source), path.basename(tmpId));
        const final = `${source}.gz`;
        this.save({ ...state, state: "COMPRESSING", tmp: tmpId });
        const hash = createHash("sha256");
        let rawBytes = 0;
        const meter = new Transform({ transform(chunk, _encoding, callback) {
          hash.update(chunk); rawBytes += chunk.length; callback(null, chunk);
        } });
        await pipeline(createReadStream(source), meter, createGzip({ level: 9, memLevel: 9, windowBits: 15 }), createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
        const expected = { rawBytes, sha256: hash.digest("hex") };
        await this.syncFile(tmp);
        const verified = await this.digest(tmp, true);
        const current = await this.digest(source);
        const after = await stat(source);
        if (verified.sha256 !== expected.sha256 || verified.rawBytes !== rawBytes || current.sha256 !== expected.sha256 ||
          current.rawBytes !== rawBytes || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          this.save({ ...state, state: "QUARANTINED", tmp: tmpId, reason: "source_changed_or_verification_failed" });
          throw new Error("Source changed or gzip verification failed; source preserved");
        }
        let working: ArchiveState = { ...state, ...expected, state: "COMPRESSING", tmp: tmpId };
        this.save(working);
        this.fault(failAt, "after_tmp");
        // link() publishes atomically without replacing an existing target.
        await link(tmp, final);
        await this.syncDirectory(final);
        this.fault(failAt, "after_publish");
        working = { ...working, generation: await this.generation(final) };
        this.save({ ...working, state: "GZIP_COMMITTED" });
        this.fault(failAt, "after_commit");
        if (!this.sameGeneration(before, await this.generation(source))) {
          this.save({ ...working, state: "QUARANTINED", reason: "source_changed_before_unlink" });
          throw new Error("Source changed before unlink; preserving source and gzip");
        }
        await unlink(source);
        await this.syncDirectory(source);
        this.fault(failAt, "after_unlink");
        await unlink(tmp);
        await this.syncDirectory(tmp);
        this.save({ ...working, tmp: undefined, state: "COMPRESSED" });
        return { compressed: true };
      });
    } finally { release(); }
  }

  async recover() {
    const rows = this.database.prepare("SELECT id FROM archives").all() as Array<{id: string}>;
    for (const {id} of rows) {
      await this.withFile(id, async () => {
        const state = this.getState(id)!;
        if (state.state === "DELETING") { await this.finishDelete(state); return; }
        if (!["COMPRESSING", "GZIP_COMMITTED"].includes(state.state)) return;
        const source = await this.exists(id);
        const gzip = await this.exists(`${id}.gz`);
        try {
          if (!gzip) {
            if (source) {
              // Only our own unpublished temporary file can be removed, and only
              // while the original source still exists. All other artifacts survive.
              if (state.tmp && this.ownsTemporary(id, state.tmp)) {
                const temporary = await this.exists(state.tmp);
                if (temporary) { await unlink(temporary); await this.syncDirectory(temporary); }
              }
              this.save({ ...state, state: "CLOSED", tmp: undefined, reason: "retry_after_interrupted_compression" });
            } else this.save({ ...state, state: "QUARANTINED", reason: "no_source_or_gzip" });
            return;
          }
          const packed = await this.digest(gzip, true);
          if (!state.sha256 || packed.sha256 !== state.sha256 || packed.rawBytes !== state.rawBytes) throw new Error("gzip_mismatch");
          const generation = await this.generation(gzip);
          if (source) {
            const before = await this.generation(source);
            const plain = await this.digest(source);
            if (plain.sha256 !== state.sha256 || plain.rawBytes !== state.rawBytes) throw new Error("source_mismatch");
            this.save({ ...state, generation, state: "GZIP_COMMITTED" });
            if (!this.sameGeneration(before, await this.generation(source))) throw new Error("source_changed_before_unlink");
            await unlink(source);
            await this.syncDirectory(source);
          }
          if (state.tmp && this.ownsTemporary(id, state.tmp)) {
            const temporary = await this.exists(state.tmp);
            if (temporary) { await unlink(temporary); await this.syncDirectory(temporary); }
          }
          this.save({ ...state, generation, state: "COMPRESSED", tmp: undefined, reason: undefined });
        } catch (error) {
          this.save({ ...state, state: "QUARANTINED", reason: (error as Error).message });
        }
      });
    }
  }

  async remove(input: string, isActive?: () => boolean) {
    const id = this.logical(input);
    await this.withFile(id, async () => {
      if (isActive?.()) throw new Error("현재 수집 중인 채팅 파일은 삭제할 수 없습니다.");
      const state = this.getState(id) || { id, state: "UNKNOWN", updatedAt: Date.now() };
      if (!["UNKNOWN", "CLOSED", "COMPRESSED", "DELETED"].includes(state.state)) throw new Error("Archive must be safely closed before deletion");
      if (state.state === "DELETED") return;
      if (["UNKNOWN", "CLOSED"].includes(state.state) && await this.exists(`${id}.gz`)) throw new Error("Unexpected second representation; deletion refused");
      this.save({ ...state, state: "DELETING" });
      await this.finishDelete(state);
    });
  }

  private async finishDelete(state: ArchiveState) {
    for (const candidate of [state.id, `${state.id}.gz`, state.tmp]) {
      if (!candidate) continue;
      const filename = await this.exists(candidate);
      if (filename) { await unlink(filename); await this.syncDirectory(filename); }
    }
    this.save({ ...state, state: "DELETED", tmp: undefined });
  }
}
