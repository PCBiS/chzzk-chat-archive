import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CRAWLER_CONFIG,
  readPublicSettings,
  updateSettings,
  validateChzzkCookies
} from "../src/settings";

test("uses safe global crawler defaults when no crawler settings exist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-settings-"));
  assert.deepEqual((await readPublicSettings(root)).crawler, DEFAULT_CRAWLER_CONFIG);
});

test("persists global scan intervals and an unlimited off-chat duration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-settings-"));
  const crawler = {
    statusPollSeconds: 90,
    scanStaggerSeconds: 20,
    offChatLimitMinutes: null,
    webDeleteEnabled: false
  };
  const result = await updateSettings(root, { streamers: [], crawler });
  assert.deepEqual(result.crawler, crawler);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "crawler.json"), "utf8")), crawler);
});

test("rejects invalid global crawler intervals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-settings-"));
  await assert.rejects(() =>
    updateSettings(root, {
      streamers: [],
      crawler: { statusPollSeconds: 0, scanStaggerSeconds: 15, offChatLimitMinutes: null }
    })
  );
  await assert.rejects(() =>
    updateSettings(root, {
      streamers: [],
      crawler: { statusPollSeconds: 60.5, scanStaggerSeconds: 15, offChatLimitMinutes: null }
    })
  );
  await assert.rejects(() =>
    updateSettings(root, {
      streamers: [],
      crawler: { statusPollSeconds: 60, scanStaggerSeconds: 15.5, offChatLimitMinutes: null }
    })
  );
  await assert.rejects(() =>
    updateSettings(root, {
      streamers: [],
      crawler: { statusPollSeconds: 60, scanStaggerSeconds: 15, offChatLimitMinutes: 30.5 }
    })
  );
});

test("returns stored credentials for the authenticated read-only settings view", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-settings-"));
  const publicSettings = await updateSettings(root, {
    streamers: [{ channelId: "channel_123", name: "테스트 스트리머", enabled: true }],
    credentials: { NID_AUT: "secret-aut", NID_SES: "secret-ses" }
  });
  assert.equal(publicSettings.streamers[0]?.enabled, true);
  assert.deepEqual(publicSettings.credentials, {
    nidAutConfigured: true,
    nidSesConfigured: true,
    NID_AUT: "secret-aut",
    NID_SES: "secret-ses"
  });
  assert.equal((await readFile(path.join(root, "credentials.json"), "utf8")).includes("secret-aut"), true);
  assert.deepEqual(await readPublicSettings(root), publicSettings);
});

test("preserves credentials on blank update and supports explicit clearing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-settings-"));
  await updateSettings(root, {
    streamers: [],
    credentials: { NID_AUT: "saved-aut", NID_SES: "saved-ses" }
  });
  const preserved = await updateSettings(root, {
    streamers: [],
    credentials: { NID_AUT: "", NID_SES: "" }
  });
  assert.equal(preserved.credentials.nidAutConfigured, true);
  const cleared = await updateSettings(root, { streamers: [], credentials: { clear: true } });
  assert.deepEqual(cleared.credentials, {
    nidAutConfigured: false,
    nidSesConfigured: false,
    NID_AUT: "",
    NID_SES: ""
  });
});

test("rejects duplicate or unsafe channel settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-settings-"));
  await assert.rejects(() =>
    updateSettings(root, {
      streamers: [
        { channelId: "same_channel", name: "A", enabled: true },
        { channelId: "same_channel", name: "B", enabled: true }
      ]
    })
  );
  await assert.rejects(() =>
    updateSettings(root, {
      streamers: [{ channelId: "../../etc", name: "A", enabled: true }]
    })
  );
});

test("validates CHZZK cookies with authenticated user status", async () => {
  let requestedUrl = "";
  let cookieHeader = "";
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    cookieHeader = String((init?.headers as Record<string, string>)?.Cookie || "");
    return new Response(JSON.stringify({
      content: {
        loggedIn: true,
        userIdHash: "hashed-user",
        nickname: "테스트사용자"
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const result = await validateChzzkCookies(
    { NID_AUT: "aut-value", NID_SES: "ses-value" },
    mockFetch
  );
  assert.equal(requestedUrl.endsWith("/nng_main/v1/user/getUserStatus"), true);
  assert.equal(cookieHeader.includes("NID_AUT=aut-value"), true);
  assert.equal(cookieHeader.includes("NID_SES=ses-value"), true);
  assert.deepEqual(result, {
    ok: true,
    status: "valid",
    message: "CHZZK 로그인 쿠키가 정상으로 확인되었습니다.",
    nickname: "테스트사용자"
  });
});

test("rejects successful HTTP responses without a logged-in user", async () => {
  const mockFetch = (async () =>
    new Response(JSON.stringify({ content: { loggedIn: false } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
  const result = await validateChzzkCookies(
    { NID_AUT: "aut-value", NID_SES: "ses-value" },
    mockFetch
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "not_logged_in");
});

test("cookie monitor separates expired cookies from failed checks and logs transitions once", async () => {
  const { CookieMonitor } = await import("../src/cookie-monitor");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const dir = await mkdtemp(nodePath.join(os.tmpdir(), "cookie-monitor-"));
  const events: string[] = [];
  const logger = { log: async (_c: string, _l: string, event: string) => { events.push(event); } } as any;
  let next: any = { ok: false, status: "network_error", message: "네트워크" };
  let calls = 0;
  const monitor = new CookieMonitor(dir, logger, async () => { calls += 1; return next; });

  assert.equal(monitor.snapshot().state, "unknown");
  assert.equal((await monitor.check()).state, "missing");
  assert.equal(calls, 0, "no request is made without stored cookies");

  await writeFile(nodePath.join(dir, "credentials.json"), JSON.stringify({ NID_AUT: "synthetic-aut", NID_SES: "synthetic-ses" }));
  assert.equal((await monitor.check()).state, "failed");
  next = { ok: false, status: "expired", message: "만료" };
  assert.equal((await monitor.check()).state, "expired");
  assert.equal((await monitor.check()).state, "expired");
  next = { ok: true, status: "valid", message: "정상", nickname: "시험계정" };
  const valid = await monitor.check();
  assert.equal(valid.state, "valid");
  assert.equal(valid.nickname, "시험계정");
  assert.ok(valid.checkedAt);
  assert.deepEqual(events, ["cookie_check_failed", "cookie_expired", "cookie_recovered"]);
  assert.doesNotMatch(JSON.stringify(monitor.snapshot()), /synthetic-(aut|ses)/);
});

test("web deletion defaults to on for existing settings and must be a boolean", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-settings-"));
  const legacy = { statusPollSeconds: 60, scanStaggerSeconds: 20, offChatLimitMinutes: null };
  const result = await updateSettings(root, { streamers: [], crawler: legacy });
  assert.equal(result.crawler.webDeleteEnabled, true);
  await assert.rejects(updateSettings(root, { streamers: [], crawler: { ...legacy, webDeleteEnabled: "false" } }), /웹 삭제/);
});
