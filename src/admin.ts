import path from "node:path";
import { promisify } from "node:util";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const scrypt = promisify(scryptCallback);

interface AdminRecord {
  version: 1;
  username: string;
  salt: string;
  passwordHash: string;
  createdAt: string;
}

function adminPath(configDir: string) {
  return path.join(configDir, "admin.json");
}

function validateUsername(value: unknown) {
  const username = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    throw new Error("아이디는 영문, 숫자, _, -, . 조합으로 3~64자여야 합니다.");
  }
  return username;
}

function validatePassword(value: unknown) {
  if (typeof value !== "string" || value.length < 6 || value.length > 256) {
    throw new Error("비밀번호는 6자 이상 256자 이하여야 합니다.");
  }
  return value;
}

async function readAdmin(configDir: string): Promise<AdminRecord | null> {
  try {
    const record = JSON.parse(await readFile(adminPath(configDir), "utf8")) as AdminRecord;
    if (
      record.version !== 1 ||
      typeof record.username !== "string" ||
      typeof record.salt !== "string" ||
      typeof record.passwordHash !== "string"
    ) {
      throw new Error("관리자 계정 파일이 올바르지 않습니다.");
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function adminExists(configDir: string) {
  return Boolean(await readAdmin(configDir));
}

export async function createAdmin(configDir: string, usernameInput: unknown, passwordInput: unknown) {
  const username = validateUsername(usernameInput);
  const password = validatePassword(passwordInput);
  await mkdir(configDir, { recursive: true });
  const salt = randomBytes(16);
  const passwordHash = (await scrypt(password, salt, 64)) as Buffer;
  const record: AdminRecord = {
    version: 1,
    username,
    salt: salt.toString("base64url"),
    passwordHash: passwordHash.toString("base64url"),
    createdAt: new Date().toISOString()
  };
  try {
    await writeFile(adminPath(configDir), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("관리자 계정이 이미 설정되어 있습니다.");
    }
    throw error;
  }
  return { username };
}

export async function verifyAdmin(configDir: string, usernameInput: unknown, passwordInput: unknown) {
  const record = await readAdmin(configDir);
  if (!record || typeof usernameInput !== "string" || typeof passwordInput !== "string") return false;
  const expected = Buffer.from(record.passwordHash, "base64url");
  const actual = (await scrypt(passwordInput, Buffer.from(record.salt, "base64url"), expected.length)) as Buffer;
  const usernameMatches = Buffer.from(usernameInput).length === Buffer.from(record.username).length
    && timingSafeEqual(Buffer.from(usernameInput), Buffer.from(record.username));
  return usernameMatches && actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function ensureSessionSecret(configDir: string, configuredSecret?: string) {
  if (configuredSecret && configuredSecret.length >= 32) return configuredSecret;
  const filePath = path.join(configDir, "session-secret");
  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(configDir, { recursive: true });
  const generated = randomBytes(48).toString("base64url");
  try {
    await writeFile(filePath, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = (await readFile(filePath, "utf8")).trim();
    if (existing.length < 32) throw new Error("세션 비밀키 파일이 올바르지 않습니다.");
    return existing;
  }
}
