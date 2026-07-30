import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { assertArchiveFile, normalizeRelativePath, resolveInside, safeSegment } from "../src/paths";

test("normalizes safe relative paths", () => {
  assert.equal(normalizeRelativePath("streamer/session.jsonl"), "streamer/session.jsonl");
  assert.equal(normalizeRelativePath("/streamer\\session.jsonl"), "streamer/session.jsonl");
});

test("rejects path traversal", () => {
  assert.throws(() => normalizeRelativePath("../../etc/passwd"));
  assert.throws(() => resolveInside("/data/archive", "../secret"));
});

test("accepts archive extensions only", () => {
  assert.doesNotThrow(() => assertArchiveFile("chat.jsonl"));
  assert.doesNotThrow(() => assertArchiveFile("chat.TXT"));
  assert.throws(() => assertArchiveFile("credentials.json"));
});

test("creates filesystem-safe streamer segments", () => {
  assert.equal(safeSegment("테스트 / 방송"), "테스트_방송");
  assert.equal(safeSegment("../../"), "unknown");
  assert.equal(resolveInside("/data/archive", "a/b"), path.resolve("/data/archive/a/b"));
});
