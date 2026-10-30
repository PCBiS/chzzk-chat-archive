import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import type { ArchiveStore } from "./archive-store";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { ArchiveRecord } from "./types";
import { assertArchiveFile, normalizeRelativePath, resolveExistingInside } from "./paths";

interface CountRow {
  count: number;
}

interface UserRow {
  id: string | null;
  nickname: string;
  count: number;
}

interface RecordRow {
  raw_json: string;
}

function searchText(value: string | null | undefined) {
  return (value || "").toLocaleLowerCase("ko-KR");
}

function likePattern(value: string) {
  return `%${searchText(value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export class ChatIndex {
  private database: DatabaseSync;
  private insertRecord;
  private syncChains = new Map<string, Promise<void>>();

  private constructor(
    private dataDir: string,
    databasePath: string,
    private archiveStore?: ArchiveStore
  ) {
    this.database = new DatabaseSync(databasePath);
    const schema = (this.database.prepare("PRAGMA user_version").get() as {user_version: number}).user_version;
    if (schema > 1) { this.database.close(); throw new Error("지원하지 않는 검색 DB 버전입니다."); }
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_key TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        message_at TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        streamer_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event TEXT NOT NULL,
        user_id TEXT,
        nickname TEXT NOT NULL,
        user_id_search TEXT NOT NULL,
        nickname_search TEXT NOT NULL,
        message_search TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_file_id ON messages(file_path, id);
      CREATE INDEX IF NOT EXISTS idx_messages_file_user ON messages(file_path, user_id_search, nickname_search);
      CREATE TABLE IF NOT EXISTS indexed_files (
        file_path TEXT PRIMARY KEY,
        indexed_bytes INTEGER NOT NULL DEFAULT 0,
        invalid_lines INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
    if (schema === 0) this.database.exec("PRAGMA user_version = 1");
    const indexedFileColumns = this.database.prepare("PRAGMA table_info(indexed_files)").all() as Array<{ name: string }>;
    if (!indexedFileColumns.some((column) => column.name === "invalid_lines")) {
      this.database.exec("ALTER TABLE indexed_files ADD COLUMN invalid_lines INTEGER NOT NULL DEFAULT 0");
    }
    this.insertRecord = this.database.prepare(`
      INSERT OR IGNORE INTO messages (
        record_key, file_path, recorded_at, message_at, channel_id, streamer_name,
        session_id, event, user_id, nickname, user_id_search, nickname_search,
        message_search, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  static async open(dataDir: string, archiveStore?: ArchiveStore) {
    const indexDirectory = path.join(dataDir, ".chzzk-index");
    await mkdir(indexDirectory, { recursive: true });
    return new ChatIndex(dataDir, path.join(indexDirectory, "chat.sqlite"), archiveStore);
  }

  close() {
    this.database.close();
  }

  addRecord(filePath: string, record: ArchiveRecord) {
    const relative = normalizeRelativePath(filePath);
    const raw = JSON.stringify(record);
    const key = createHash("sha256").update(relative).update("\0").update(raw).digest("hex");
    this.insertRecord.run(
      key,
      relative,
      record.recordedAt,
      record.messageAt,
      record.streamer.channelId,
      record.streamer.name,
      record.broadcast.sessionId,
      record.event,
      record.user.id,
      record.user.nickname,
      searchText(record.user.id),
      searchText(record.user.nickname),
      searchText(record.message),
      raw
    );
  }

  async syncAll() {
    for (const relative of await this.archiveFiles(this.dataDir)) {
      // Startup must never decompress old archives implicitly.
      if (this.archiveStore) {
        // An unavailable archive must not prevent the collector from starting.
        try { if ((await this.archiveStore.resolve(relative)).encoding === "gzip") continue; }
        catch { continue; }
      }
      await this.syncFile(relative);
    }
  }

  async syncFile(relativeInput: unknown, rebuildCompressed = false) {
    const relative = normalizeRelativePath(relativeInput);
    assertArchiveFile(relative);
    const previous = this.syncChains.get(relative) || Promise.resolve();
    const operation = () => this.syncFileNow(relative, rebuildCompressed);
    const current = previous.catch(() => {}).then(() => this.archiveStore && relative.endsWith(".jsonl") ? this.archiveStore.withFile(relative, operation) : operation());
    this.syncChains.set(relative, current);
    try {
      await current;
    } finally {
      if (this.syncChains.get(relative) === current) this.syncChains.delete(relative);
    }
  }

  removeFile(relativeInput: unknown) {
    const relative = normalizeRelativePath(relativeInput);
    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM messages WHERE file_path = ?").run(relative);
      this.database.prepare("DELETE FROM indexed_files WHERE file_path = ?").run(relative);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async analyze(
    relativeInput: unknown,
    options: { user?: string; query?: string; offset: number; limit: number | null }
  ) {
    const relative = normalizeRelativePath(relativeInput);
    await this.syncFile(relative);
    const total = Number(
      (this.database.prepare("SELECT COUNT(*) AS count FROM messages WHERE file_path = ?").get(relative) as unknown as CountRow)
        .count
    );
    const invalidLines = Number(
      (this.database.prepare("SELECT invalid_lines FROM indexed_files WHERE file_path = ?").get(relative) as
        | { invalid_lines?: number | bigint }
        | undefined)?.invalid_lines || 0
    );
    const users = this.database.prepare(`
      WITH grouped AS (
        SELECT
          COALESCE(user_id, 'nickname:' || nickname_search) AS identity,
          COUNT(*) AS count,
          MAX(id) AS latest_id
        FROM messages
        WHERE file_path = ?
        GROUP BY identity
      )
      SELECT m.user_id AS id, m.nickname, grouped.count
      FROM grouped
      JOIN messages m ON m.id = grouped.latest_id
      ORDER BY grouped.count DESC, m.nickname COLLATE NOCASE ASC
    `).all(relative) as unknown as UserRow[];

    const clauses = ["file_path = ?"];
    const parameters: Array<string | number> = [relative];
    if (options.user?.trim()) {
      clauses.push("(nickname_search LIKE ? ESCAPE '\\' OR user_id_search LIKE ? ESCAPE '\\')");
      const pattern = likePattern(options.user);
      parameters.push(pattern, pattern);
    }
    if (options.query?.trim()) {
      clauses.push("message_search LIKE ? ESCAPE '\\'");
      parameters.push(likePattern(options.query));
    }
    const where = clauses.join(" AND ");
    const filtered = Number(
      (this.database.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${where}`).get(...parameters) as unknown as CountRow)
        .count
    );
    const rows = (options.limit === null
      ? this.database.prepare(`
          SELECT raw_json
          FROM messages
          WHERE ${where}
          ORDER BY id ASC
        `).all(...parameters)
      : this.database.prepare(`
          SELECT raw_json
          FROM messages
          WHERE ${where}
          ORDER BY id ASC
          LIMIT ? OFFSET ?
        `).all(...parameters, options.limit, options.offset)) as unknown as RecordRow[];

    return {
      totalMessages: total,
      filteredMessages: filtered,
      uniqueUsers: users.length,
      invalidLines,
      users: users.map((user) => ({ id: user.id, nickname: user.nickname, count: Number(user.count) })),
      messages: rows.map((row) => JSON.parse(row.raw_json) as ArchiveRecord)
    };
  }

  private async syncFileNow(relative: string, rebuildCompressed = false) {
    const resolved = this.archiveStore && relative.endsWith(".jsonl") ? await this.archiveStore.resolve(relative) : null;
    const absolute = resolved?.physicalPath || await resolveExistingInside(this.dataDir, relative);
    if (!(await stat(absolute)).isFile()) throw new Error("파일이 아닙니다.");
    const progress = this.database
      .prepare("SELECT indexed_bytes FROM indexed_files WHERE file_path = ?")
      .get(relative) as { indexed_bytes?: number | bigint } | undefined;
    let offset = Number(progress?.indexed_bytes || 0);
    const compressed = resolved?.encoding === "gzip";
    const size = compressed ? resolved.rawBytes : (await stat(absolute)).size;
    if (compressed && size === offset && !rebuildCompressed) return;
    if (compressed && !rebuildCompressed) throw new Error("압축 파일의 검색 DB가 없습니다. 명시적으로 재색인을 요청하세요.");
    if (compressed) {
      await this.rebuildGzip(relative, absolute, size, resolved.sha256!);
      return;
    }
    if (size < offset) {
      this.removeFile(relative);
      offset = 0;
    }
    if (size === offset) return;

    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let consumed = offset;
    const source = createReadStream(absolute, { start: offset });
    const input = compressed ? source.pipe(createGunzip()) : source;
    source.on("error", error => input.destroy(error));
    try {
    for await (const chunk of input) {
      const data = pending.length ? Buffer.concat([pending, chunk as Buffer]) : (chunk as Buffer);
      let start = 0;
      let invalidLines = 0;
      const records: ArchiveRecord[] = [];
      for (let index = data.indexOf(0x0a, start); index !== -1; index = data.indexOf(0x0a, start)) {
        const lineBuffer = data.subarray(start, index);
        const line = lineBuffer.toString("utf8").replace(/\r$/, "");
        if (line.trim()) {
          try {
            records.push(JSON.parse(line) as ArchiveRecord);
          } catch {
            // Preserve archive compatibility: malformed lines are skipped but marked consumed.
            invalidLines += 1;
          }
        }
        consumed += index + 1 - start;
        start = index + 1;
      }
      pending = data.subarray(start);

      this.database.exec("BEGIN");
      try {
        for (const record of records) {
          try {
            this.addRecord(relative, record);
          } catch {
            // Records that do not match the archive schema remain in JSONL but are not indexed.
            invalidLines += 1;
          }
        }
        this.database.prepare(`
          INSERT INTO indexed_files(file_path, indexed_bytes, invalid_lines, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(file_path) DO UPDATE SET
            indexed_bytes = excluded.indexed_bytes,
            invalid_lines = indexed_files.invalid_lines + excluded.invalid_lines,
            updated_at = excluded.updated_at
        `).run(relative, consumed, invalidLines, new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    } finally {
      source.destroy();
      input.destroy();
    }

    if (consumed === offset) {
      return;
    }
  }

  private async rebuildGzip(relative: string, absolute: string, rawBytes: number, expectedHash: string) {
    // Build in a separate connection: never keep the live connection's
    // transaction open across await, where collector writes could join it.
    const directory = await mkdtemp(path.join(this.dataDir, ".chzzk-index", "rebuild-"));
    const filename = path.join(directory, "staged.sqlite");
    let staged: ChatIndex | undefined;
    let attached = false;
    let transaction = false;
    const source = createReadStream(absolute);
    const input = source.pipe(createGunzip());
    source.on("error", error => input.destroy(error));
    try {
      staged = new ChatIndex(this.dataDir, filename);
      const hash = createHash("sha256");
      let readBytes = 0, consumed = 0, invalid = 0;
      let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      for await (const chunk of input) {
        hash.update(chunk); readBytes += chunk.length;
        if (readBytes > rawBytes) throw new Error("압축 원문 길이가 검증된 크기를 초과했습니다.");
        const data = pending.length ? Buffer.concat([pending, chunk as Buffer]) : chunk as Buffer;
        let start = 0;
        staged.database.exec("BEGIN");
        try {
          for (let end = data.indexOf(10, start); end !== -1; end = data.indexOf(10, start)) {
            const line = data.subarray(start, end).toString("utf8").replace(/\r$/, "");
            if (line.trim()) {
              try { staged.addRecord(relative, JSON.parse(line) as ArchiveRecord); }
              catch { invalid += 1; }
            }
            consumed += end + 1 - start;
            start = end + 1;
          }
          staged.database.exec("COMMIT");
        } catch (error) { staged.database.exec("ROLLBACK"); throw error; }
        pending = data.subarray(start);
      }
      if (pending.length || readBytes !== rawBytes || hash.digest("hex") !== expectedHash) {
        throw new Error("압축 원문 무결성 또는 마지막 줄 검증에 실패했습니다.");
      }
      await this.archiveStore!.resolve(relative); // Recheck generation before committing.
      staged.close(); staged = undefined;
      this.database.prepare("ATTACH DATABASE ? AS rebuild_archive").run(filename);
      attached = true;
      this.database.exec("BEGIN IMMEDIATE"); transaction = true;
      this.database.prepare("DELETE FROM messages WHERE file_path = ?").run(relative);
      const columns = "record_key,file_path,recorded_at,message_at,channel_id,streamer_name,session_id,event,user_id,nickname,user_id_search,nickname_search,message_search,raw_json";
      this.database.exec(`INSERT INTO messages(${columns}) SELECT ${columns} FROM rebuild_archive.messages ORDER BY id`);
      this.database.prepare(`INSERT INTO indexed_files(file_path,indexed_bytes,invalid_lines,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(file_path) DO UPDATE SET indexed_bytes=excluded.indexed_bytes,invalid_lines=excluded.invalid_lines,updated_at=excluded.updated_at`)
        .run(relative, consumed, invalid, new Date().toISOString());
      this.database.exec("COMMIT"); transaction = false;
    } catch (error) {
      if (transaction) this.database.exec("ROLLBACK");
      throw error;
    } finally {
      source.destroy(); input.destroy();
      staged?.close();
      if (attached) this.database.exec("DETACH DATABASE rebuild_archive");
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async archiveFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.archiveFiles(absolute));
      } else if (entry.isFile() && /\.jsonl(?:\.gz)?$/i.test(entry.name)) {
        files.push(path.relative(this.dataDir, absolute).replaceAll("\\", "/").replace(/\.gz$/i, ""));
      }
    }
    return [...new Set(files)];
  }
}
