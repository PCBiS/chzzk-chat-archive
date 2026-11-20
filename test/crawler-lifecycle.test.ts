import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StreamerWorker, compressEligibleArchives } from "../src/crawler";
import { ArchiveStore } from "../src/archive-store";
import { ChatIndex } from "../src/chat-index";

async function fixture(offChatLimitMs: number | null = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archive-cycle-"));
  const store = new ArchiveStore(root);
  await store.init();
  const index = await ChatIndex.open(root, store);
  const logger = { log: async () => {} } as any;
  const worker: any = new StreamerWorker({ channelId: "test", name: "fixture", enabled: true }, {}, root, 30_000, offChatLimitMs, logger, index, 0, store);
  const events: string[] = [];
  logger.log = async (_scope: string, _level: string, event: string) => { events.push(event); };
  let detail: any = { liveId: 100, openDate: "2026-10-01T00:00:00+09:00", liveTitle: "first" };
  worker.client = {
    live: { detail: async () => detail },
    chat: () => ({ connected: true, on() {}, connect: async () => {}, disconnect: async () => {}, requestRecentChat() {} })
  };
  return { root, store, index, worker, events, setDetail: (value: any) => { detail = value; }, cleanup: async () => { await worker.stop(); index.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("queued append retains its original file and broadcast context during off transition", async () => {
  const f = await fixture();
  try {
    await f.worker.handleOpen({ status: "OPEN", chatChannelId: "chat" });
    const first = f.worker.getSnapshot().file;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lease = f.store.withFile(first, async () => { entered(); await gate; });
    await ready;
    const pending = f.worker.record("chat", { time: 1000, message: "live", profile: { nickname: "fixture" } });
    await f.worker.handleClose({ status: "CLOSE" });
    const second = f.worker.getSnapshot().file;
    release();
    await lease;
    await pending;
    await f.worker.record("chat", { time: 2000, message: "off" });
    const live = JSON.parse((await readFile(path.join(f.root, first), "utf8")).trim());
    const off = JSON.parse((await readFile(path.join(f.root, second), "utf8")).trim());
    assert.equal(live.broadcast.kind, "live");
    assert.equal(off.broadcast.kind, "off");
    assert.equal((await f.index.analyze(first, { offset: 0, limit: 20 })).messages[0].message, "live");
    assert.equal(f.store.getState(first)?.state, "ACTIVE");
  } finally { await f.cleanup(); }
});

test("same liveId cannot seal; distinct real successor seals both files and scheduler waits seven days", async () => {
  const f = await fixture();
  try {
    await f.worker.handleOpen({ status: "OPEN", chatChannelId: "chat" });
    const live = f.worker.getSnapshot().file;
    await f.worker.record("chat", { time: 1000, message: "live" });
    await f.worker.handleClose({ status: "CLOSE" });
    const off = f.worker.getSnapshot().file;
    await f.worker.record("chat", { time: 2000, message: "off" });
    await f.worker.handleOpen({ status: "OPEN", chatChannelId: "chat" });
    assert.equal(f.store.getState(live)?.state, "ACTIVE");
    assert.equal(f.store.getState(off)?.state, "ACTIVE");
    f.setDetail({ liveId: 101, openDate: "2026-10-02T00:00:00+09:00" });
    await f.worker.handleOpen({ status: "OPEN", chatChannelId: "chat" });
    await f.worker.sealQueue;
    assert.equal(f.store.getState(live)?.state, "CLOSED");
    assert.equal(f.store.getState(off)?.state, "CLOSED");
    assert.deepEqual(await compressEligibleArchives(f.store, f.index), []);
    const compressed = await compressEligibleArchives(f.store, f.index, Date.now() + 8 * 86400_000);
    assert.equal(compressed.length, 2);
    assert.ok(compressed.every(result => result.compressed));
    assert.equal((await f.index.analyze(live, { offset: 0, limit: 20 })).totalMessages, 1);
  } finally { await f.cleanup(); }
});

test("fallback identifiers or a missing confirmed opening never complete a cycle", async () => {
  const f = await fixture();
  try {
    f.setDetail({ openDate: "2026-10-01T00:00:00+09:00" });
    await f.worker.handleOpen({ status: "OPEN", chatChannelId: "fallback" });
    const file = f.worker.getSnapshot().file;
    await f.worker.record("chat", { time: 1000, message: "fallback" });
    f.setDetail({ liveId: 101 });
    await f.worker.handleOpen({ status: "OPEN", chatChannelId: "chat" });
    await f.worker.sealQueue;
    assert.equal(f.store.getState(file)?.state, "ACTIVE");
    assert.deepEqual(await compressEligibleArchives(f.store, f.index, Date.now() + 8 * 86400_000), []);
  } finally { await f.cleanup(); }
});

test("cached active path cannot append after sealing or compression", async t => {
  const f = await fixture();
  t.mock.method(console, "error", () => {});
  try {
    await f.worker.handleOpen({ status: "OPEN", chatChannelId: "chat" });
    const file = f.worker.getSnapshot().file;
    await f.worker.record("chat", { time: 1000, message: "original" });
    const original = await readFile(path.join(f.root, file), "utf8");
    await f.index.syncFile(file);
    await f.store.registerClosed(file, { channelId: "test", sessionId: "100", successorId: "101", lastRecordAt: Date.now() - 8 * 86400_000 });
    await f.worker.record("chat", { time: 2000, message: "refuse closed" });
    assert.equal(await readFile(path.join(f.root, file), "utf8"), original);
    assert.equal(f.store.getState(file)?.state, "CLOSED");
    assert.equal((await f.store.compress(file, Date.now() + 8 * 86400_000)).compressed, true);
    await f.worker.record("chat", { time: 3000, message: "refuse compressed" });
    await assert.rejects(readFile(path.join(f.root, file)), { code: "ENOENT" });
    assert.equal(f.store.getState(file)?.state, "COMPRESSED");
    assert.equal((await f.index.analyze(file, { offset: 0, limit: 20 })).totalMessages, 1);
  } finally { await f.cleanup(); }
});

function restartedWorker(f: Awaited<ReturnType<typeof fixture>>, offChatLimitMs: number | null = null) {
  const logger = { log: async (_scope: string, _level: string, event: string) => { f.events.push(event); } } as any;
  const next: any = new StreamerWorker({ channelId: "test", name: "fixture", enabled: true }, {}, f.root, 30_000, offChatLimitMs, logger, f.index, 0, f.store);
  next.client = f.worker.client;
  return next;
}

test("worker started after the broadcast closed resumes off collection for the official last broadcast", async () => {
  const f = await fixture();
  try {
    f.setDetail({ status: "CLOSE", liveId: 100, openDate: "2026-10-01 00:00:00", closeDate: "2026-10-01 05:00:00", liveTitle: "first" });
    await f.worker.handleClose({ status: "CLOSE", chatChannelId: "chat" });
    const snapshot = f.worker.getSnapshot();
    assert.equal(snapshot.archiveKind, "off");
    assert.equal(snapshot.sessionId, "100");
    assert.match(snapshot.file, /_fixture_off\.jsonl$/);
    assert.ok(f.events.includes("off_archive_resumed"));
    await f.worker.record("chat", { time: 1000, message: "after restart" });
    const record = JSON.parse((await readFile(path.join(f.root, snapshot.file), "utf8")).trim());
    assert.equal(record.broadcast.kind, "off");
    assert.equal(record.broadcast.sessionId, "100");
    assert.equal(record.broadcast.openedAt, "2026-10-01 00:00:00");
    // The resumed file belongs to the closed broadcast and is sealed by the next real one.
    f.setDetail({ liveId: 101, openDate: "2026-10-02T00:00:00+09:00" });
    await f.worker.handleOpen({ status: "OPEN", chatChannelId: "chat" });
    await f.worker.sealQueue;
    assert.equal(f.store.getState(snapshot.file)?.state, "CLOSED");
  } finally { await f.cleanup(); }
});

test("restart during off collection keeps the same broadcast identity in a new off file", async () => {
  const f = await fixture();
  try {
    f.setDetail({ liveId: 100, openDate: "2026-10-01 00:00:00", liveTitle: "first" });
    await f.worker.handleOpen({ status: "OPEN", chatChannelId: "chat" });
    await f.worker.handleClose({ status: "CLOSE", chatChannelId: "chat" });
    const before = f.worker.getSnapshot().file;
    await f.worker.record("chat", { time: 1000, message: "off before restart" });
    await f.worker.stop();
    await new Promise(resolve => setTimeout(resolve, 1100));
    f.setDetail({ status: "CLOSE", liveId: 100, openDate: "2026-10-01 00:00:00", closeDate: "2026-10-01 05:00:00" });
    const next = restartedWorker(f);
    try {
      await next.handleClose({ status: "CLOSE", chatChannelId: "chat" });
      const after = next.getSnapshot().file;
      assert.notEqual(after, before);
      assert.equal(next.getSnapshot().sessionId, "100");
      await next.record("chat", { time: 2000, message: "off after restart" });
      f.setDetail({ liveId: 101, openDate: "2026-10-02T00:00:00+09:00" });
      await next.handleOpen({ status: "OPEN", chatChannelId: "chat" });
      await next.sealQueue;
      assert.equal(f.store.getState(before)?.state, "CLOSED");
      assert.equal(f.store.getState(after)?.state, "CLOSED");
    } finally { await next.stop(); }
  } finally { await f.cleanup(); }
});

test("without an official last broadcast the newest active archive identity is resumed", async () => {
  const f = await fixture();
  try {
    await f.worker.handleOpen({ status: "OPEN", chatChannelId: "chat" });
    await f.worker.record("chat", { time: 1000, message: "live" });
    await f.worker.stop();
    f.setDetail({ status: "CLOSE" });
    const next = restartedWorker(f);
    try {
      await next.handleClose({ status: "CLOSE", chatChannelId: "chat" });
      assert.equal(next.getSnapshot().archiveKind, "off");
      assert.equal(next.getSnapshot().sessionId, "100");
    } finally { await next.stop(); }
  } finally { await f.cleanup(); }
});

test("off collection is not resumed without a chat channel, an identity, or inside an expired limit", async () => {
  const f = await fixture(60_000);
  try {
    f.setDetail({ status: "CLOSE", liveId: 100, openDate: "2026-10-01 00:00:00", closeDate: "2026-10-01 05:00:00" });
    await f.worker.handleClose({ status: "CLOSE" });
    assert.equal(f.worker.getSnapshot().archiveKind, null);
    const expired = restartedWorker(f, 60_000);
    await expired.handleClose({ status: "CLOSE", chatChannelId: "chat" });
    assert.equal(expired.getSnapshot().archiveKind, null);
    await expired.stop();
    const recent = new Date(Date.now() - 10_000).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" });
    f.setDetail({ status: "CLOSE", liveId: 100, openDate: "2026-10-01 00:00:00", closeDate: recent });
    const within = restartedWorker(f, 60_000);
    await within.handleClose({ status: "CLOSE", chatChannelId: "chat" });
    assert.equal(within.getSnapshot().archiveKind, "off");
    await within.stop();
    f.setDetail({ status: "CLOSE" });
    const unknown = restartedWorker(f);
    await unknown.handleClose({ status: "CLOSE", chatChannelId: "chat" });
    assert.equal(unknown.getSnapshot().archiveKind, null);
    await unknown.stop();
  } finally { await f.cleanup(); }
});

test("resume is decided once and never replaces collection that saw the live transition", async () => {
  const f = await fixture();
  try {
    await f.worker.handleOpen({ status: "OPEN", chatChannelId: "chat" });
    let detailCalls = 0;
    const original = f.worker.client.live.detail;
    f.worker.client.live.detail = async () => { detailCalls += 1; return original(); };
    await f.worker.handleClose({ status: "CLOSE", chatChannelId: "chat" });
    await f.worker.handleClose({ status: "CLOSE", chatChannelId: "chat" });
    assert.equal(detailCalls, 0);
    assert.ok(!f.events.includes("off_archive_resumed"));
    const fresh = restartedWorker(f);
    fresh.client = { ...f.worker.client, live: { detail: async () => { detailCalls += 1; return { status: "OPEN" }; } } };
    await fresh.handleClose({ status: "CLOSE", chatChannelId: "chat" });
    assert.equal(fresh.getSnapshot().archiveKind, null);
    assert.equal(fresh.resumeChecked, false);
    await fresh.stop();
  } finally { await f.cleanup(); }
});
