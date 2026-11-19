import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

interface StoredKey {
  id: string;
  name: string;
  hash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PublicKey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const MAX_KEYS = 20;

function digest(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Read-only access keys for the MCP endpoint. Only a SHA-256 of each key is kept;
 * keys are 256 random bits, so a fast hash is sufficient.
 */
export class McpKeyStore {
  private keys: StoredKey[] = [];
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private configDir: string) {}

  private get file() {
    return path.join(this.configDir, "mcp-keys.json");
  }

  private async load() {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as StoredKey[];
      this.keys = Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string" && typeof item.hash === "string") : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("MCP 키 파일을 읽을 수 없습니다.");
      this.keys = [];
    }
    this.loaded = true;
  }

  private save() {
    const snapshot = JSON.stringify(this.keys, null, 2);
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      await mkdir(this.configDir, { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${snapshot}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    });
    return this.writeChain;
  }

  async list(): Promise<PublicKey[]> {
    await this.load();
    return this.keys.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt }));
  }

  /** Returns the key itself exactly once. */
  async create(nameInput: unknown): Promise<PublicKey & { key: string }> {
    await this.load();
    const name = typeof nameInput === "string" ? nameInput.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 60) throw new Error("키 이름은 1~60자로 입력하세요.");
    if (this.keys.length >= MAX_KEYS) throw new Error(`키는 ${MAX_KEYS}개까지 만들 수 있습니다. 쓰지 않는 키를 먼저 폐기하세요.`);
    const key = `cca_${randomBytes(32).toString("base64url")}`;
    const stored: StoredKey = { id: randomUUID(), name, hash: digest(key), createdAt: new Date().toISOString(), lastUsedAt: null };
    this.keys.push(stored);
    await this.save();
    return { id: stored.id, name, createdAt: stored.createdAt, lastUsedAt: null, key };
  }

  async revoke(id: unknown) {
    await this.load();
    const before = this.keys.length;
    this.keys = this.keys.filter((item) => item.id !== id);
    if (this.keys.length === before) return false;
    await this.save();
    return true;
  }

  async verify(key: unknown): Promise<PublicKey | null> {
    if (typeof key !== "string" || !key.startsWith("cca_") || key.length > 200) return null;
    await this.load();
    const candidate = Buffer.from(digest(key), "hex");
    let match: StoredKey | null = null;
    for (const item of this.keys) {
      const expected = Buffer.from(item.hash, "hex");
      if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) match = item;
    }
    if (!match) return null;
    const now = Date.now();
    // Avoid a config write on every call: remember use at most once an hour.
    if (!match.lastUsedAt || now - Date.parse(match.lastUsedAt) > 60 * 60_000) {
      match.lastUsedAt = new Date(now).toISOString();
      void this.save().catch(() => {});
    }
    return { id: match.id, name: match.name, createdAt: match.createdAt, lastUsedAt: match.lastUsedAt };
  }
}
