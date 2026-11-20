import path from "node:path";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import readline from "node:readline";
import { createGunzip } from "node:zlib";
import { formatArchiveTimestamp } from "./crawler";
import type { ArchiveStore } from "./archive-store";
import type { ChatIndex } from "./chat-index";

const LIVE_NAME = /^(\d{6}_\d{2}h\d{2}m\d{2}s)(_.+_live\.jsonl)$/;
const SPACED_LOCAL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Before 0.7.1, live files were named from CHZZK's "YYYY-MM-DD HH:MM:SS"
 * openDate read in the host timezone, so on UTC hosts the name was 9 hours late.
 * Returns the corrected name only when the current name is exactly that
 * misreading; any other name (already correct, or named another way) is kept.
 */
export function correctedLiveArchiveName(name: string, openedAt: unknown): string | null {
  const match = LIVE_NAME.exec(name);
  if (!match || typeof openedAt !== "string" || !SPACED_LOCAL.test(openedAt)) return null;
  const misread = formatArchiveTimestamp(new Date(`${openedAt.replace(" ", "T")}Z`));
  const correct = formatArchiveTimestamp(openedAt);
  return match[1] === misread && correct !== misread ? `${correct}${match[2]}` : null;
}

async function firstOpenedAt(filename: string, compressed: boolean): Promise<unknown> {
  const source = createReadStream(filename);
  const input = compressed ? source.pipe(createGunzip()) : source;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try { return JSON.parse(line)?.broadcast?.openedAt; } catch { return undefined; }
    }
    return undefined;
  } finally { lines.close(); input.destroy(); source.destroy(); }
}

/** Startup migration: correct misnamed live archives. Runs before collection starts. */
export async function correctLiveArchiveNames(dataDir: string, store: ArchiveStore, index: ChatIndex) {
  const result = { renamed: 0, failed: 0 };
  for (const directory of await readdir(dataDir, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.name.startsWith(".")) continue;
    for (const entry of await readdir(path.join(dataDir, directory.name), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const compressed = entry.name.endsWith(".jsonl.gz");
      const name = compressed ? entry.name.slice(0, -3) : entry.name;
      if (!LIVE_NAME.test(name)) continue;
      try {
        const corrected = correctedLiveArchiveName(name, await firstOpenedAt(path.join(dataDir, directory.name, entry.name), compressed));
        if (!corrected) continue;
        const from = path.posix.join(directory.name, name);
        const to = path.posix.join(directory.name, corrected);
        await store.renameArchive(from, to, () => index.renameFile(from, to));
        result.renamed += 1;
      } catch {
        // One file that cannot be moved must not block startup or the others.
        result.failed += 1;
      }
    }
  }
  return result;
}
