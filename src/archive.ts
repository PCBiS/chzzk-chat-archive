import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import readline from "node:readline";
import type { ArchiveRecord } from "./types";
import type { ArchiveStore } from "./archive-store";
import { assertArchiveFile, assertPublicArchivePath, resolveExistingInside, resolveInside } from "./paths";

export async function appendRecord(filePath: string, record: ArchiveRecord): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(filePath, { flags: "a", encoding: "utf8", mode: 0o640 });
    stream.on("error", reject);
    stream.end(`${JSON.stringify(record)}\n`, resolve);
  });
}

export async function listArchive(root: string, relativeInput: unknown, store?: ArchiveStore) {
  const relative = assertPublicArchivePath(relativeInput);
  const directory = await resolveExistingInside(root, relative);
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error("폴더만 탐색할 수 있습니다.");
  const items = await Promise.all(
    (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink() && !entry.name.startsWith("."))
      .map(async (entry) => {
        if (entry.isFile() && !/\.(?:jsonl(?:\.gz)?|txt)$/i.test(entry.name)) return null;
        try {
        const absolute = resolveInside(directory, entry.name);
        const entryStat = await stat(absolute);
        const gzip = entry.isFile() && /\.jsonl\.gz$/i.test(entry.name);
        const logicalName = gzip ? entry.name.slice(0, -3) : entry.name;
        const itemPath = path.posix.join(relative, logicalName);
        const resolved = store && logicalName.endsWith(".jsonl") ? await store.withFile(itemPath, () => store.resolve(itemPath)) : null;
        return {
          name: logicalName,
          path: itemPath,
          type: entry.isDirectory() ? "directory" : "file",
          size: resolved ? (await stat(resolved.physicalPath)).size : entry.isFile() ? entryStat.size : null,
          encoding: resolved?.encoding || (gzip ? "gzip" : "plain"),
          rawSize: resolved?.rawBytes ?? (entry.isFile() ? entryStat.size : null),
          modifiedAt: entryStat.mtime.toISOString()
        };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          // A damaged/quarantined file must not hide healthy sibling archives.
          return { name: entry.name.replace(/\.gz$/i, ""), path: path.posix.join(relative, entry.name.replace(/\.gz$/i, "")),
            type: "file", size: null, rawSize: null, encoding: "unavailable", modifiedAt: new Date(0).toISOString() };
        }
      })
  );
  return items
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .filter((item) => item.type === "directory" || [".jsonl", ".txt"].includes(path.extname(item.name).toLowerCase()))
    .filter((item, index, all) => all.findIndex(other => other.path === item.path) === index)
    .sort((a, b) => a.type.localeCompare(b.type) || b.modifiedAt.localeCompare(a.modifiedAt));
}

export interface AnalyzeOptions {
  user?: string;
  query?: string;
  offset: number;
  limit: number;
}

export async function analyzeArchive(root: string, relativeInput: unknown, options: AnalyzeOptions) {
  const filePath = await resolveExistingInside(root, relativeInput);
  assertArchiveFile(filePath);
  if (!(await stat(filePath)).isFile()) throw new Error("파일이 아닙니다.");

  const users = new Map<string, { id: string | null; nickname: string; count: number }>();
  const messages: ArchiveRecord[] = [];
  let total = 0;
  let filtered = 0;
  let invalidLines = 0;
  const userNeedle = options.user?.trim().toLocaleLowerCase("ko-KR") ?? "";
  const queryNeedle = options.query?.trim().toLocaleLowerCase("ko-KR") ?? "";

  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let record: ArchiveRecord;
    try {
      record = JSON.parse(line) as ArchiveRecord;
    } catch {
      invalidLines += 1;
      continue;
    }
    if (!record.user || typeof record.message !== "string") {
      invalidLines += 1;
      continue;
    }
    total += 1;
    const identity = record.user.id || `nickname:${record.user.nickname.toLocaleLowerCase("ko-KR")}`;
    const previous = users.get(identity);
    users.set(identity, {
      id: record.user.id,
      nickname: record.user.nickname,
      count: (previous?.count ?? 0) + 1
    });

    const matchesUser =
      !userNeedle ||
      record.user.nickname.toLocaleLowerCase("ko-KR").includes(userNeedle) ||
      (record.user.id?.toLocaleLowerCase("ko-KR").includes(userNeedle) ?? false);
    const matchesQuery = !queryNeedle || record.message.toLocaleLowerCase("ko-KR").includes(queryNeedle);
    if (!matchesUser || !matchesQuery) continue;
    if (filtered >= options.offset && messages.length < options.limit) messages.push(record);
    filtered += 1;
  }

  return {
    totalMessages: total,
    filteredMessages: filtered,
    uniqueUsers: users.size,
    invalidLines,
    users: [...users.values()].sort((a, b) => b.count - a.count || a.nickname.localeCompare(b.nickname, "ko")),
    messages
  };
}
