import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { ChatIndex } from "../src/chat-index";
import { EmojiStore, allowedEmojiUrl, emojiKey } from "../src/emoji-store";
import { listArchive, parseArchiveName } from "../src/archive";
import { createServer } from "../src/server";
import { OperationalLogger } from "../src/logs";
import type { CrawlerManager } from "../src/crawler";
import type { ArchiveRecord } from "../src/types";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("synthetic")]);
const GOOD = "https://nng-phinf.pstatic.net/glive/subscription/emoji/synthetic/1/sampleHi.png";
const HTML = "https://ssl.pstatic.net/static/synthetic/notAnImage.png";

function record(message: string, emojis?: Record<string, string>): ArchiveRecord {
  return {
    schemaVersion: 1, recordedAt: "2026-07-30T00:00:00.000Z", messageAt: "2026-07-30T00:00:00.000Z",
    streamer: { channelId: "synthetic-channel", name: "시험 방송" },
    broadcast: { sessionId: "1", title: "시험", openedAt: "2026-07-30T00:00:00.000Z", kind: "live" },
    event: "chat", user: { id: "synthetic-user", nickname: "시험사용자" }, message, hidden: false, recent: false,
    ...(emojis ? { extras: { emojis, extraToken: "synthetic-secret-token" } } : {})
  };
}

function fakeFetcher(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    if (url === GOOD) return new Response(PNG, { status: 200 });
    if (url === HTML) return new Response("<html></html>", { status: 200 });
    return new Response("", { status: 404 });
  };
}

async function temporary(t: TestContext, prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("emoji URLs are limited to HTTPS on the known image hosts", () => {
  assert.equal(allowedEmojiUrl(GOOD), GOOD);
  for (const value of [
    "http://nng-phinf.pstatic.net/a.png", "https://example.com/a.png", "https://nng-phinf.pstatic.net.example.com/a.png",
    "https://user@ssl.pstatic.net/a.png", "https://ssl.pstatic.net:8443/a.png", "javascript:alert(1)", "", null, 1,
    `https://ssl.pstatic.net/${"a".repeat(600)}`
  ]) assert.equal(allowedEmojiUrl(value), null);
});

test("emoji store downloads observed images, rejects non-images and resolves only stored ones", async t => {
  const root = await temporary(t, "emoji-store-");
  const calls: string[] = [];
  const store = new EmojiStore(root, { fetcher: fakeFetcher(calls), fetchDelayMs: 0 });
  await store.init();
  t.after(() => store.stop());
  const extras = { emojis: { sampleHi: GOOD, notImage: HTML, evil: "https://example.com/x.png" } };
  assert.equal(store.resolve("{:sampleHi:}", extras), undefined, "nothing is served before it is downloaded");
  store.observe(extras);
  store.observe(extras);
  await store.fetchPending();
  assert.deepEqual(calls.sort(), [GOOD, HTML].sort(), "each allowed URL is fetched once; other hosts never");
  assert.deepEqual(store.counts(), { failed: 1, ok: 1 });
  assert.deepEqual(store.resolve("안녕 {:sampleHi:} {:notImage:} {:evil:} {:unknown:}", extras), { sampleHi: emojiKey(GOOD) });
  assert.equal(store.resolve("토큰 없음", extras), undefined);
  const file = await store.file(emojiKey(GOOD));
  assert.equal(file?.contentType, "image/png");
  assert.deepEqual(await readFile(file!.path), PNG);
  assert.equal(await store.file(emojiKey(HTML)), null);
  assert.equal(await store.file("../emoji.sqlite"), null);
});

test("weekly refresh scans the index once, retries failures and restores missing files", async t => {
  const root = await temporary(t, "emoji-refresh-");
  const relative = "streamer/260730_09h00m00s_streamer_live.jsonl";
  await mkdir(path.join(root, "streamer"));
  await writeFile(path.join(root, relative), [record("{:sampleHi:}", { sampleHi: GOOD }), record("plain")].map(item => JSON.stringify(item)).join("\n") + "\n");
  const index = await ChatIndex.open(root);
  t.after(() => index.close());
  await index.syncFile(relative);
  const calls: string[] = [];
  const store = new EmojiStore(root, { fetcher: fakeFetcher(calls), fetchDelayMs: 0 });
  await store.init();
  t.after(() => store.stop());
  await store.refresh(index);
  assert.deepEqual(calls, [GOOD]);
  await store.refresh(index);
  assert.deepEqual(calls, [GOOD], "stored images are not downloaded again");
  await unlink((await store.file(emojiKey(GOOD)))!.path);
  await store.refresh(index);
  assert.deepEqual(calls, [GOOD, GOOD], "a missing file is restored");
  assert.deepEqual(store.counts(), { ok: 1 });
});

test("network-disabled store records URLs without fetching", async t => {
  const root = await temporary(t, "emoji-offline-");
  const calls: string[] = [];
  const store = new EmojiStore(root, { fetcher: fakeFetcher(calls), networkEnabled: false });
  await store.init();
  t.after(() => store.stop());
  store.observe({ emojis: { sampleHi: GOOD } });
  await store.fetchPending();
  assert.deepEqual(calls, []);
  assert.deepEqual(store.counts(), { pending: 1 });
});

test("archive names give the broadcast start in KST and order the explorer", async t => {
  assert.deepEqual(parseArchiveName("260821_02h23m53s_시험_방송_live.jsonl"), { startedAt: "2026-08-20T17:23:53.000Z", kind: "live" });
  assert.equal(parseArchiveName("269921_02h23m53s_x_live.jsonl"), null);
  assert.equal(parseArchiveName("notes.txt"), null);
  const root = await temporary(t, "archive-order-");
  await mkdir(path.join(root, "s"));
  // Written oldest-last so modification time disagrees with broadcast order.
  for (const name of ["261101_20h00m00s_s_live.jsonl.gz", "261102_01h00m00s_s_off.jsonl", "261031_20h00m00s_s_live.jsonl", "260915_20h00m00s_s_live.jsonl.gz"].reverse()) {
    await writeFile(path.join(root, "s", name), "");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const items = await listArchive(root, "s");
  assert.deepEqual(items.map(item => item.name), [
    "261102_01h00m00s_s_off.jsonl", "261101_20h00m00s_s_live.jsonl", "261031_20h00m00s_s_live.jsonl", "260915_20h00m00s_s_live.jsonl"
  ]);
  assert.deepEqual(items.map(item => item.kind), ["off", "live", "live", "live"]);
});

test("analysis API returns display fields only and serves stored emoji to signed-in users", async t => {
  const root = await temporary(t, "emoji-http-");
  const directories = Object.fromEntries(["config", "data", "logs", "public"].map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(directories).map(directory => mkdir(directory)));
  const index = await ChatIndex.open(directories.data);
  const store = new EmojiStore(directories.data, { fetcher: fakeFetcher([]), fetchDelayMs: 0 });
  await store.init();
  index.recordObserver = item => store.observe(item.extras);
  await writeFile(path.join(directories.data, "sample.jsonl"), JSON.stringify(record("hi {:sampleHi:}", { sampleHi: GOOD })) + "\n");
  await index.syncFile("sample.jsonl");
  await store.fetchPending();
  const app = createServer({
    configDir: directories.config, dataDir: directories.data, logsDir: directories.logs, publicDir: directories.public,
    sessionSecret: "synthetic-emoji-http-session-secret-000000000", trustProxy: false,
    crawler: { snapshots: () => [] } as unknown as CrawlerManager,
    chatIndex: index, emojiStore: store, logger: new OperationalLogger(directories.logs)
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.stop(); index.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const key = emojiKey(GOOD);
  assert.equal((await fetch(`${base}/api/emoji/${key}`)).status, 401);
  const credentials = { username: "fixture-admin", password: "Synthetic-Test-Password-2026!" };
  const json = { "content-type": "application/json" };
  await (await fetch(`${base}/api/auth/setup`, { method: "POST", headers: json, body: JSON.stringify(credentials) })).arrayBuffer();
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify(credentials) });
  const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0] };
  await login.arrayBuffer();
  const analysis = await fetch(`${base}/api/analysis?path=sample.jsonl&limit=all`, { headers });
  const text = await analysis.text();
  assert.doesNotMatch(text, /synthetic-secret-token|extras|pstatic/);
  assert.deepEqual(JSON.parse(text).messages, [{
    messageAt: "2026-07-30T00:00:00.000Z", event: "chat", user: { id: "synthetic-user", nickname: "시험사용자" },
    message: "hi {:sampleHi:}", emojis: { sampleHi: key }
  }]);
  const image = await fetch(`${base}/api/emoji/${key}`, { headers });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  assert.equal((await fetch(`${base}/api/emoji/${"0".repeat(32)}`, { headers })).status, 404);
});

test("calendar counts come from names and range listing only returns matching days", async t => {
  const { archiveDays } = await import("../src/archive");
  const root = await temporary(t, "archive-days-");
  await mkdir(path.join(root, "s"));
  for (const name of ["261101_20h00m00s_s_live.jsonl.gz", "261101_23h30m00s_s_off.jsonl", "261102_00h10m00s_s_live.jsonl",
    "261102_00h10m00s_s_live.jsonl.gz", "251231_23h59m59s_s_live.jsonl", "memo.txt", "ignored.bin"]) {
    await writeFile(path.join(root, "s", name), "");
  }
  assert.deepEqual(await archiveDays(root, "s"), {
    days: { "2026-11-01": { live: 1, off: 1 }, "2026-11-02": { live: 1, off: 0 }, "2025-12-31": { live: 1, off: 0 } },
    undated: 1
  });
  const names = async (range: object) => (await listArchive(root, "s", undefined, range)).map(item => item.name);
  assert.deepEqual(await names({ from: "2026-11-01", to: "2026-11-01" }), ["261101_23h30m00s_s_off.jsonl", "261101_20h00m00s_s_live.jsonl"]);
  assert.deepEqual(await names({ from: "2026-11-02" }), ["261102_00h10m00s_s_live.jsonl"]);
  assert.deepEqual(await names({ undated: true }), ["memo.txt"]);
  await assert.rejects(() => archiveDays(root, ".chzzk-index"), /내부 저장 경로/);
});
