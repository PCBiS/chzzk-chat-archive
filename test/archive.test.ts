import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeArchive } from "../src/archive";
import type { ArchiveRecord } from "../src/types";

function record(id: string, nickname: string, message: string): ArchiveRecord {
  return {
    schemaVersion: 1,
    recordedAt: "2026-07-30T00:00:00.000Z",
    messageAt: "2026-07-30T00:00:00.000Z",
    streamer: { channelId: "channel", name: "streamer" },
    broadcast: { sessionId: "1", title: "test", openedAt: "2026-07-30T00:00:00.000Z", kind: "live" },
    event: "chat",
    user: { id, nickname },
    message,
    hidden: false,
    recent: false
  };
}

test("counts unique users by id and filters messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-archive-"));
  const lines = [
    record("same-id", "닉네임1", "안녕하세요"),
    record("same-id", "변경된닉네임", "두 번째"),
    record("other-id", "다른사람", "안녕하세요")
  ];
  await writeFile(path.join(root, "sample.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const result = await analyzeArchive(root, "sample.jsonl", {
    user: "same-id",
    query: "",
    offset: 0,
    limit: 100
  });
  assert.equal(result.totalMessages, 3);
  assert.equal(result.uniqueUsers, 2);
  assert.equal(result.filteredMessages, 2);
  assert.equal(result.users.find((user) => user.id === "same-id")?.count, 2);
});
