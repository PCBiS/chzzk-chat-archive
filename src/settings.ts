import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { CrawlerConfig, StreamerConfig } from "./types";

export const DEFAULT_CRAWLER_CONFIG: CrawlerConfig = {
  statusPollSeconds: 60,
  scanStaggerSeconds: 20,
  offChatLimitMinutes: null
};

export interface Credentials {
  NID_AUT?: string;
  NID_SES?: string;
}

export interface PublicSettings {
  streamers: StreamerConfig[];
  crawler: CrawlerConfig;
  credentials: {
    nidAutConfigured: boolean;
    nidSesConfigured: boolean;
    NID_AUT: string;
    NID_SES: string;
  };
  credentialValidation?: {
    ok: true;
    message: string;
    nickname?: string;
  };
}

export interface SettingsUpdate {
  streamers: unknown;
  crawler?: unknown;
  credentials?: {
    NID_AUT?: unknown;
    NID_SES?: unknown;
    clear?: unknown;
  };
  validateCredentials?: unknown;
}

export interface CookieValidationResult {
  ok: boolean;
  status: "valid" | "missing" | "expired" | "not_logged_in" | "unexpected" | "network_error";
  message: string;
  nickname?: string;
}

export async function validateChzzkCookies(
  credentials: Credentials,
  fetchImplementation: typeof fetch = fetch
): Promise<CookieValidationResult> {
  const nidAut = credentials.NID_AUT?.trim() || "";
  const nidSes = credentials.NID_SES?.trim() || "";
  if (!nidAut || !nidSes) {
    return {
      ok: false,
      status: "missing",
      message: "NID_AUT와 NID_SES를 모두 입력해야 합니다."
    };
  }
  try {
    const response = await fetchImplementation(
      "https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          Referer: "https://chzzk.naver.com/",
          Origin: "https://chzzk.naver.com",
          Cookie: `NID_SES=${nidSes}; NID_AUT=${nidAut}`
        },
        signal: AbortSignal.timeout(5000)
      }
    );
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: "expired", message: "쿠키가 만료되었거나 로그인이 필요합니다." };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: "unexpected",
        message: `CHZZK 인증 확인 API가 HTTP ${response.status}로 응답했습니다.`
      };
    }
    const body = await response.json() as {
      content?: { loggedIn?: boolean; userIdHash?: string; nickname?: string };
    };
    const content = body?.content;
    if (content?.loggedIn === true && typeof content.userIdHash === "string" && content.userIdHash) {
      return {
        ok: true,
        status: "valid",
        message: "CHZZK 로그인 쿠키가 정상으로 확인되었습니다.",
        ...(content.nickname ? { nickname: content.nickname } : {})
      };
    }
    return {
      ok: false,
      status: "not_logged_in",
      message: "응답은 정상이지만 로그인 사용자 정보가 확인되지 않았습니다."
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      status: "network_error",
      message: timedOut
        ? "CHZZK 쿠키 확인 요청 시간이 초과되었습니다."
        : "CHZZK 쿠키 확인 중 네트워크 오류가 발생했습니다."
    };
  }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`${path.basename(filePath)} 파일을 읽을 수 없습니다.`);
  }
}

export async function readRawSettings(configDir: string) {
  const streamers = await readJson<StreamerConfig[]>(path.join(configDir, "streamers.json"), []);
  const credentials = await readJson<Credentials>(path.join(configDir, "credentials.json"), {});
  const crawler = validateCrawlerConfig(
    await readJson<unknown>(path.join(configDir, "crawler.json"), DEFAULT_CRAWLER_CONFIG)
  );
  return { streamers, credentials, crawler };
}

export async function readPublicSettings(configDir: string): Promise<PublicSettings> {
  const { streamers, credentials, crawler } = await readRawSettings(configDir);
  return {
    streamers,
    crawler,
    credentials: {
      nidAutConfigured: Boolean(credentials.NID_AUT),
      nidSesConfigured: Boolean(credentials.NID_SES),
      NID_AUT: credentials.NID_AUT || "",
      NID_SES: credentials.NID_SES || ""
    }
  };
}

export function validateCrawlerConfig(input: unknown): CrawlerConfig {
  if (!input || typeof input !== "object") {
    throw new Error("전역 크롤러 설정이 올바르지 않습니다.");
  }
  const item = input as Record<string, unknown>;
  const statusPollSeconds = Number(item.statusPollSeconds ?? DEFAULT_CRAWLER_CONFIG.statusPollSeconds);
  const scanStaggerSeconds = Number(item.scanStaggerSeconds ?? DEFAULT_CRAWLER_CONFIG.scanStaggerSeconds);
  const rawLimit = item.offChatLimitMinutes;
  const offChatLimitMinutes = rawLimit === null || rawLimit === undefined ? null : Number(rawLimit);

  if (!Number.isInteger(statusPollSeconds) || statusPollSeconds < 1 || statusPollSeconds > 86_400) {
    throw new Error("방송 상태 확인 주기는 1~86400초 사이의 정수여야 합니다.");
  }
  if (!Number.isInteger(scanStaggerSeconds) || scanStaggerSeconds < 1 || scanStaggerSeconds > 3_600) {
    throw new Error("스트리머 간 스캔 간격은 1~3600초 사이의 정수여야 합니다.");
  }
  if (
    offChatLimitMinutes !== null
    && (!Number.isInteger(offChatLimitMinutes) || offChatLimitMinutes < 1 || offChatLimitMinutes > 525_600)
  ) {
    throw new Error("방종 후 수집 제한은 1~525600분 사이의 정수로 설정하거나 무제한을 선택해야 합니다.");
  }
  return {
    statusPollSeconds,
    scanStaggerSeconds,
    offChatLimitMinutes
  };
}

function validateStreamers(input: unknown): StreamerConfig[] {
  if (!Array.isArray(input)) throw new Error("스트리머 목록이 올바르지 않습니다.");
  if (input.length > 100) throw new Error("스트리머는 최대 100명까지 등록할 수 있습니다.");
  const seen = new Set<string>();
  return input.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`${index + 1}번째 스트리머 정보가 올바르지 않습니다.`);
    }
    const item = candidate as Record<string, unknown>;
    const channelId = typeof item.channelId === "string" ? item.channelId.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(channelId)) {
      throw new Error(`${index + 1}번째 채널 ID가 올바르지 않습니다.`);
    }
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) {
      throw new Error(`${index + 1}번째 스트리머 이름이 올바르지 않습니다.`);
    }
    if (seen.has(channelId)) throw new Error(`중복된 채널 ID입니다: ${channelId}`);
    seen.add(channelId);
    return { channelId, name, enabled: item.enabled === true };
  });
}

function optionalCookie(value: unknown, field: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} 값이 올바르지 않습니다.`);
  }
  return value;
}

async function writeJsonAtomic(filePath: string, value: unknown, mode: number) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function updateSettings(configDir: string, input: SettingsUpdate): Promise<PublicSettings> {
  const streamers = validateStreamers(input.streamers);
  const current = await readRawSettings(configDir);
  const crawler = input.crawler === undefined ? current.crawler : validateCrawlerConfig(input.crawler);
  const clear = input.credentials?.clear === true;
  const nidAut = optionalCookie(input.credentials?.NID_AUT, "NID_AUT");
  const nidSes = optionalCookie(input.credentials?.NID_SES, "NID_SES");
  const credentials: Credentials = clear
    ? {}
    : {
        NID_AUT: nidAut ?? current.credentials.NID_AUT ?? "",
        NID_SES: nidSes ?? current.credentials.NID_SES ?? ""
      };

  let credentialValidation: PublicSettings["credentialValidation"];
  if (input.validateCredentials === true && !clear && (credentials.NID_AUT || credentials.NID_SES)) {
    const result = await validateChzzkCookies(credentials);
    if (!result.ok) throw new Error(`쿠키 검증 실패: ${result.message}`);
    credentialValidation = {
      ok: true,
      message: result.message,
      ...(result.nickname ? { nickname: result.nickname } : {})
    };
  }

  await writeJsonAtomic(path.join(configDir, "streamers.json"), streamers, 0o640);
  await writeJsonAtomic(path.join(configDir, "crawler.json"), crawler, 0o640);
  await writeJsonAtomic(path.join(configDir, "credentials.json"), credentials, 0o600);
  return {
    streamers,
    crawler,
    credentials: {
      nidAutConfigured: Boolean(credentials.NID_AUT),
      nidSesConfigured: Boolean(credentials.NID_SES),
      NID_AUT: credentials.NID_AUT || "",
      NID_SES: credentials.NID_SES || ""
    },
    ...(credentialValidation ? { credentialValidation } : {})
  };
}
