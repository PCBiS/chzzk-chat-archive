import { readRawSettings, validateChzzkCookies, type CookieValidationResult } from "./settings";
import type { OperationalLogger } from "./logs";

export interface CookieHealth {
  /** "valid" | "expired" | "failed" | "missing", or "unknown" before the first check. */
  state: "valid" | "expired" | "failed" | "missing" | "unknown";
  message: string;
  nickname?: string;
  checkedAt: string | null;
}

const DAY = 24 * 60 * 60_000;

function classify(result: CookieValidationResult): CookieHealth["state"] {
  if (result.status === "valid") return "valid";
  if (result.status === "expired" || result.status === "not_logged_in") return "expired";
  if (result.status === "missing") return "missing";
  // Network trouble or an unexpected reply says nothing about the cookies themselves.
  return "failed";
}

/** Checks the stored CHZZK login cookies once a day and on demand, and records when they stop working. */
export class CookieMonitor {
  private health: CookieHealth = { state: "unknown", message: "아직 확인하지 않았습니다.", checkedAt: null };
  private running: Promise<CookieHealth> | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private configDir: string,
    private logger: Pick<OperationalLogger, "log">,
    private validate: typeof validateChzzkCookies = validateChzzkCookies
  ) {}

  snapshot(): CookieHealth {
    return { ...this.health };
  }

  check(): Promise<CookieHealth> {
    return this.running ??= this.checkNow().finally(() => { this.running = null; });
  }

  private async checkNow(): Promise<CookieHealth> {
    const { credentials } = await readRawSettings(this.configDir);
    const previous = this.health.state;
    const checkedAt = new Date().toISOString();
    if (!credentials.NID_AUT && !credentials.NID_SES) {
      this.health = { state: "missing", message: "저장된 쿠키가 없습니다. 일반 방송은 쿠키 없이 수집합니다.", checkedAt };
      return this.snapshot();
    }
    const result = await this.validate(credentials);
    const state = classify(result);
    this.health = { state, message: result.message, checkedAt, ...(result.nickname ? { nickname: result.nickname } : {}) };
    if (state === "expired" && previous !== "expired") {
      void this.logger.log("settings", "warn", "cookie_expired", "CHZZK 로그인 쿠키가 만료되었습니다. 연령 제한 방송은 수집되지 않습니다.");
    } else if (state === "valid" && previous === "expired") {
      void this.logger.log("settings", "info", "cookie_recovered", "CHZZK 로그인 쿠키가 다시 유효합니다.");
    } else if (state === "failed" && previous !== "failed") {
      void this.logger.log("settings", "warn", "cookie_check_failed", "CHZZK 로그인 쿠키를 확인하지 못했습니다.", { reason: result.status });
    }
    return this.snapshot();
  }

  start() {
    const run = () => void this.check().catch(() => {});
    const first = setTimeout(run, 60_000);
    const daily = setInterval(run, DAY);
    first.unref();
    daily.unref();
    this.timers = [first, daily];
  }

  stop() {
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    this.timers = [];
  }
}
