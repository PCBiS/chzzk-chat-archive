import assert from "node:assert/strict";
import test from "node:test";
import { archiveRelativePath, formatArchiveTimestamp, remainingScanDelay } from "../src/crawler";

test("archive timestamp is formatted in Korean local time", () => {
  assert.equal(formatArchiveTimestamp("2026-07-30T08:07:54+09:00"), "260730_08h07m54s");
  assert.equal(formatArchiveTimestamp("2026-07-29T23:07:54Z"), "260730_08h07m54s");
  assert.equal(formatArchiveTimestamp("2026-07-30T08:07:54"), "260730_08h07m54s");
});

test("live archive is stored directly below the streamer directory", () => {
  assert.equal(
    archiveRelativePath("샘플스트리머", "2026-07-30T08:07:54+09:00", "live"),
    "샘플스트리머/260730_08h07m54s_샘플스트리머_live.jsonl"
  );
});

test("post-broadcast archive uses the off suffix and transition time", () => {
  assert.equal(
    archiveRelativePath("샘플스트리머", "2026-07-30T17:23:31+09:00", "off"),
    "샘플스트리머/260730_17h23m31s_샘플스트리머_off.jsonl"
  );
});

test("new scheduler waits for the remaining global scan stagger", () => {
  assert.equal(remainingScanDelay(100_000, 20_000, 110_000), 10_000);
  assert.equal(remainingScanDelay(100_000, 20_000, 125_000), 0);
  assert.equal(remainingScanDelay(0, 20_000, 110_000), 0);
});
