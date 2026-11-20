import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { link, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appendRecord } from "../src/archive";
import { ArchiveStore } from "../src/archive-store";
import { ChatIndex } from "../src/chat-index";
import { correctLiveArchiveNames, correctedLiveArchiveName } from "../src/archive-rename";

test("only the exact UTC misreading of a spaced openDate is corrected", () => {
  assert.equal(correctedLiveArchiveName("261120_19h11m47s_s_live.jsonl", "2026-11-20 19:11:47"), null);
  assert.equal(correctedLiveArchiveName("261121_04h11m47s_s_off.jsonl", "2026-11-20 19:11:47"), null);
  assert.equal(correctedLiveArchiveName("261121_04h11m47s_s_live.jsonl", "2026-11-20T19:11:47"), null);
  assert.equal(correctedLiveArchiveName("261121_04h11m47s_s_live.jsonl", "2026-11-20T10:11:47.000Z"), null);
  assert.equal(correctedLiveArchiveName("261121_04h11m47s_s_live.jsonl", "2026-11-20 19:11:47"), "261120_19h11m47s_s_live.jsonl");
});

function record(openedAt: string, sessionId: string, message: string, kind: "live" | "off" = "live") {
  const at = new Date(Date.parse(`${openedAt.replace(" ", "T")}+09:00`) + 60_000).toISOString();
  return {
    schemaVersion: 1 as const, recordedAt: at, messageAt: at,
    streamer: { channelId: "c", name: "s" },
    broadcast: { sessionId, title: "", openedAt, kind },
    event: "chat" as const, user: { id: null, nickname: "n" }, message, hidden: false, recent: false
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "archive-rename-"));
  const store = new ArchiveStore(root);
  await store.init();
  const index = await ChatIndex.open(root, store);
  const write = async (name: string, rec: ReturnType<typeof record>) => {
    const id = `s/${name}`;
    await store.registerActive(id, { channelId: "c", sessionId: rec.broadcast.sessionId, openedAt: rec.broadcast.openedAt });
    await appendRecord(path.join(root, id), rec);
    await index.syncFile(id);
    return id;
  };
  return { root, store, index, write, cleanup: async () => { index.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("misnamed plain and compressed live archives move with their state and search rows", async () => {
  const f = await fixture();
  try {
    const old = await f.write("261002_09h00m00s_s_live.jsonl", record("2026-10-02 00:00:00", "100", "compressed"));
    await f.store.registerClosed(old, { channelId: "c", sessionId: "100", successorId: "101", lastRecordAt: Date.now() - 8 * 86400_000 });
    assert.equal((await f.store.compress(old, Date.now() + 8 * 86400_000)).compressed, true);
    const active = await f.write("261121_04h11m47s_s_live.jsonl", record("2026-11-20 19:11:47", "101", "active"));
    const off = await f.write("261121_05h00m00s_s_off.jsonl", record("2026-11-20 19:11:47", "101", "off", "off"));
    const right = await f.write("261005_20h00m00s_s_live.jsonl", record("2026-10-05T20:00:00", "99", "already"));

    assert.deepEqual(await correctLiveArchiveNames(f.root, f.store, f.index), { renamed: 2, failed: 0 });
    assert.deepEqual((await readdir(path.join(f.root, "s"))).sort(), [
      "261002_00h00m00s_s_live.jsonl.gz", "261005_20h00m00s_s_live.jsonl",
      "261120_19h11m47s_s_live.jsonl", "261121_05h00m00s_s_off.jsonl"
    ]);
    const movedGzip = "s/261002_00h00m00s_s_live.jsonl";
    const movedActive = "s/261120_19h11m47s_s_live.jsonl";
    assert.equal(f.store.getState(old), undefined);
    assert.equal(f.store.getState(movedGzip)?.state, "COMPRESSED");
    assert.equal(f.store.getState(movedGzip)?.id, movedGzip);
    assert.equal(f.store.getState(movedActive)?.state, "ACTIVE");
    assert.equal(f.store.getState(off)?.state, "ACTIVE");
    assert.equal(f.store.getState(right)?.state, "ACTIVE");
    // The compressed file still resolves (same generation) and keeps its search rows.
    assert.equal((await f.store.resolve(movedGzip)).encoding, "gzip");
    assert.equal((await f.index.analyze(movedGzip, { offset: 0, limit: 5 })).messages[0].message, "compressed");
    assert.equal((await f.index.analyze(movedActive, { offset: 0, limit: 5 })).totalMessages, 1);
    // Keys moved with the path: a resync and a new append neither duplicate nor lose rows.
    await f.index.syncFile(movedActive);
    await appendRecord(path.join(f.root, movedActive), record("2026-11-20 19:11:47", "101", "later"));
    await f.index.syncFile(movedActive);
    assert.equal((await f.index.analyze(movedActive, { offset: 0, limit: 5 })).totalMessages, 2);
    const db = new DatabaseSync(path.join(f.root, ".chzzk-index", "chat.sqlite"), { readOnly: true });
    try {
      for (const row of db.prepare("SELECT file_path, raw_json, record_key FROM messages").all() as any[]) {
        assert.equal(row.record_key, createHash("sha256").update(row.file_path).update("\0").update(row.raw_json).digest("hex"));
      }
      assert.equal((db.prepare("SELECT count(*) AS n FROM indexed_files WHERE file_path = ?").get(old) as any).n, 0);
    } finally { db.close(); }
    assert.deepEqual(await correctLiveArchiveNames(f.root, f.store, f.index), { renamed: 0, failed: 0 });
  } finally { await f.cleanup(); }
});

test("an existing target is never overwritten and an interrupted link is completed", async () => {
  const f = await fixture();
  try {
    const misnamed = await f.write("261121_04h11m47s_s_live.jsonl", record("2026-11-20 19:11:47", "101", "a"));
    await f.write("261120_19h11m47s_s_live.jsonl", record("2026-11-20 19:11:47", "101", "b"));
    assert.deepEqual(await correctLiveArchiveNames(f.root, f.store, f.index), { renamed: 0, failed: 1 });
    assert.equal(f.store.getState(misnamed)?.state, "ACTIVE");
    assert.equal((await f.index.analyze(misnamed, { offset: 0, limit: 5 })).totalMessages, 1);
  } finally { await f.cleanup(); }
  const g = await fixture();
  try {
    const misnamed = await g.write("261121_04h11m47s_s_live.jsonl", record("2026-11-20 19:11:47", "101", "a"));
    const target = "s/261120_19h11m47s_s_live.jsonl";
    // Simulate a stop after the index and state moved and the new name was linked.
    g.index.renameFile(misnamed, target);
    const state = g.store.getState(misnamed)!;
    (g.store as any).database.prepare("DELETE FROM archives WHERE id=?").run(misnamed);
    (g.store as any).save({ ...state, id: target });
    await link(path.join(g.root, misnamed), path.join(g.root, target));
    assert.deepEqual(await correctLiveArchiveNames(g.root, g.store, g.index), { renamed: 1, failed: 0 });
    await assert.rejects(stat(path.join(g.root, misnamed)), { code: "ENOENT" });
    assert.equal(g.store.getState(target)?.state, "ACTIVE");
    assert.equal((await g.index.analyze(target, { offset: 0, limit: 5 })).totalMessages, 1);
  } finally { await g.cleanup(); }
});
