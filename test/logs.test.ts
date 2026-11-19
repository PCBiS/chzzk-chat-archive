import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { analyzeLog, koreanDate, OperationalLogger } from "../src/logs";

test("writes categorized daily operational logs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-logs-"));
  const logger = new OperationalLogger(root);
  await logger.start();
  await logger.log("crawler", "info", "scan_started", "스캔 시작", { channelId: "abc123" });
  await logger.stop();
  const content = await readFile(path.join(root, "crawler", `${koreanDate()}.jsonl`), "utf8");
  assert.equal(content.includes('"event":"scan_started"'), true);
});

test("compresses daily logs older than seven days and analyzes gzip", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-logs-"));
  const logger = new OperationalLogger(root);
  await logger.start();
  const category = path.join(root, "system");
  const oldFile = path.join(category, "2026-07-20.jsonl");
  const record = {
    timestamp: "2026-07-20T00:00:00.000Z",
    localDate: "2026-07-20",
    level: "error",
    category: "system",
    event: "startup_failed",
    message: "실패"
  };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(oldFile, `${JSON.stringify(record)}\n`);
  await logger.rotate(new Date("2026-07-30T00:00:00Z"));
  await assert.rejects(() => stat(oldFile));
  const result = await analyzeLog(root, "system/2026-07-20.jsonl.gz", {
    level: "error",
    query: "실패",
    offset: 0,
    limit: 10
  });
  assert.equal(result.total, 1);
  assert.equal(result.filtered, 1);
  await logger.stop();
});

test("timeline merges categories newest first and only counts routine polls", async () => {
  const { logTimeline } = await import("../src/logs");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { gzipSync } = await import("node:zlib");
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-timeline-"));
  const line = (timestamp: string, category: string, level: string, event: string, message: string) =>
    JSON.stringify({ timestamp, localDate: timestamp.slice(0, 10), level, category, event, message }) + "\n";
  await mkdir(path.join(root, "crawler")); await mkdir(path.join(root, "system"));
  await writeFile(path.join(root, "crawler", "2026-08-02.jsonl"),
    line("2026-08-02T01:00:00.000Z", "crawler", "info", "scan_started", "조회 시작")
    + line("2026-08-02T01:00:01.000Z", "crawler", "info", "scan_completed", "조회 완료")
    + line("2026-08-02T03:00:00.000Z", "crawler", "info", "chat_connected", "채팅 연결") + "broken\n");
  await writeFile(path.join(root, "system", "2026-08-02.jsonl"), line("2026-08-02T02:00:00.000Z", "system", "error", "startup_failed", "시작 실패"));
  await writeFile(path.join(root, "system", "2026-08-01.jsonl.gz"), gzipSync(line("2026-08-01T05:00:00.000Z", "system", "warn", "emoji_refresh_failed", "갱신 실패")));
  await writeFile(path.join(root, "system", "2026-07-20.jsonl"), line("2026-07-20T05:00:00.000Z", "system", "info", "web_started", "범위 밖"));

  const week = await logTimeline(root, { until: "2026-08-02", days: 7, limit: 100 });
  assert.deepEqual(week.records.map(record => record.event), ["chat_connected", "startup_failed", "emoji_refresh_failed"]);
  assert.deepEqual(week.levels, { info: 1, warn: 1, error: 1 });
  assert.equal(week.routine, 2);
  assert.equal(week.invalidLines, 1);
  assert.equal(week.from, "2026-07-27");

  const withRoutine = await logTimeline(root, { until: "2026-08-02", days: 1, includeRoutine: true, category: "crawler", limit: 2 });
  assert.deepEqual(withRoutine.records.map(record => record.event), ["chat_connected", "scan_completed"]);
  assert.equal(withRoutine.truncated, true);
  assert.deepEqual(withRoutine.levels, { info: 1, warn: 0, error: 0 });

  const errors = await logTimeline(root, { until: "2026-08-02", days: 7, level: "error", query: "실패", limit: 100 });
  assert.deepEqual(errors.records.map(record => record.event), ["startup_failed"]);
});
