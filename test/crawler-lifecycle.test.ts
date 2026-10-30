import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StreamerWorker, compressEligibleArchives } from "../src/crawler";
import { ArchiveStore } from "../src/archive-store";
import { ChatIndex } from "../src/chat-index";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "archive-cycle-"));
  const store = new ArchiveStore(root);
  await store.init();
  const index = await ChatIndex.open(root, store);
  const logger = { log: async () => {} } as any;
  const worker: any = new StreamerWorker({ channelId: "test", name: "fixture", enabled: true }, {}, root, 30_000, null, logger, index, 0, store);
  let detail: any = { liveId: 100, openDate: "2026-10-01T00:00:00+09:00", liveTitle: "first" };
  worker.client = {
    live: { detail: async () => detail },
    chat: () => ({ connected: true, on() {}, connect: async () => {}, disconnect: async () => {}, requestRecentChat() {} })
  };
  return { root, store, index, worker, setDetail: (value: any) => { detail = value; }, cleanup: async () => { await worker.stop(); index.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
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
