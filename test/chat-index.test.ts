import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatIndex } from "../src/chat-index";
import { listArchive } from "../src/archive";
import type { ArchiveRecord } from "../src/types";

function record(id: string, nickname: string, message: string, second: number): ArchiveRecord {
  const at = `2026-07-30T00:00:${String(second).padStart(2, "0")}.000Z`;
  return {
    schemaVersion: 1,
    recordedAt: at,
    messageAt: at,
    streamer: { channelId: "channel", name: "streamer" },
    broadcast: { sessionId: "1", title: "test", openedAt: at, kind: "live" },
    event: "chat",
    user: { id, nickname },
    message,
    hidden: false,
    recent: false
  };
}

test("SQLite index incrementally analyzes JSONL archives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-index-"));
  const relative = "streamer/sample.jsonl";
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  const initial = [
    record("same-id", "닉네임1", "안녕하세요", 1),
    record("same-id", "변경된닉네임", "두 번째", 2),
    record("other-id", "다른사람", "안녕하세요", 3)
  ];
  await writeFile(absolute, `${initial.map((item) => JSON.stringify(item)).join("\n")}\nnot-json\n`);

  const index = await ChatIndex.open(root);
  try {
    await index.syncAll();
    const first = await index.analyze(relative, {
      user: "same-id",
      query: "",
      offset: 0,
      limit: 100
    });
    assert.equal(first.totalMessages, 3);
    assert.equal(first.uniqueUsers, 2);
    assert.equal(first.filteredMessages, 2);
    assert.equal(first.invalidLines, 1);
    assert.equal(first.users.find((user) => user.id === "same-id")?.count, 2);

    await appendFile(absolute, `${JSON.stringify(record("third-id", "새 사용자", "증분", 4))}\n`);
    const second = await index.analyze(relative, {
      query: "증분",
      offset: 0,
      limit: 100
    });
    assert.equal(second.totalMessages, 4);
    assert.equal(second.filteredMessages, 1);
    assert.equal(second.messages[0]?.message, "증분");
  } finally {
    index.close();
  }
});

test("internal SQLite directory is hidden from the archive explorer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-index-hidden-"));
  await mkdir(path.join(root, ".chzzk-index"));
  await writeFile(path.join(root, ".chzzk-index", "chat.sqlite"), "");
  await writeFile(path.join(root, "visible.jsonl"), "");

  const items = await listArchive(root, "");
  assert.deepEqual(items.map((item) => item.name), ["visible.jsonl"]);
  await assert.rejects(() => listArchive(root, ".chzzk-index"), /내부 저장 경로/);
});
