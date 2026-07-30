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
