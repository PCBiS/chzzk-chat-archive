import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { ChatIndex } from "../src/chat-index";
import { McpKeyStore } from "../src/mcp-keys";
import { createServer } from "../src/server";
import { OperationalLogger } from "../src/logs";
import { createAdmin, verifyAdmin } from "../src/admin";
import type { CrawlerManager } from "../src/crawler";
import type { ArchiveRecord } from "../src/types";

function record(second: number, nickname: string, message: string, event: ArchiveRecord["event"] = "chat"): ArchiveRecord {
  // 2026-11-18 20:00 KST onward
  const at = new Date(Date.parse("2026-11-18T11:00:00.000Z") + second * 1000).toISOString();
  return {
    schemaVersion: 1, recordedAt: at, messageAt: at,
    streamer: { channelId: "synthetic-channel", name: "시험방송" },
    broadcast: { sessionId: "777", title: "합성 방송 제목", openedAt: "2026-11-18T11:00:00.000Z", kind: "live" },
    event, user: { id: nickname === "익명" ? null : `secret-hash-${nickname}`, nickname }, message, hidden: false, recent: false,
    extras: { extraToken: "synthetic-secret-token" }
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-http-"));
  const directories = Object.fromEntries(["config", "data", "logs", "public"].map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(directories).map(directory => mkdir(directory)));
  const id = "시험방송/261118_20h00m00s_시험방송_live.jsonl";
  await mkdir(path.join(directories.data, "시험방송"));
  const records = [
    record(0, "가", "시작"), record(30, "나", "안녕하세요 {:hi:}"), record(65, "가", "두번째"),
    ...Array.from({ length: 30 }, (_, index) => record(600 + index, index % 2 ? "가" : "다", `몰아치기 ${index}`)),
    record(700, "익명", "후원합니다", "donation"), record(3600, "나", "마무리")
  ];
  await writeFile(path.join(directories.data, id), records.map(item => JSON.stringify(item)).join("\n") + "\n");
  const index = await ChatIndex.open(directories.data);
  await index.syncFile(id);
  const keys = new McpKeyStore(directories.config);
  const logger = new OperationalLogger(directories.logs);
  const app = createServer({
    configDir: directories.config, dataDir: directories.data, logsDir: directories.logs, publicDir: directories.public,
    sessionSecret: "synthetic-mcp-http-session-secret-00000000000", trustProxy: false,
    crawler: { snapshots: () => [] } as unknown as CrawlerManager, chatIndex: index, logger, mcpKeys: keys, version: "9.9.9"
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await logger.stop(); index.close(); await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const created = await keys.create("시험 키");
  let next = 1;
  const rpc = async (method: string, params?: object, key = created.key) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: next++, method, params })
    });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (name: string, args: object) => {
    const result = (await rpc("tools/call", { name, arguments: args })).body.result;
    return { text: result.content[0].text as string, isError: result.isError === true };
  };
  return { base, id, keys, created, rpc, call, directories };
}

test("MCP endpoint requires a valid key and speaks the handshake", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await f.rpc("tools/list", {}, "cca_wrong")).status, 401);
  assert.equal((await fetch(`${f.base}/mcp`, { headers: { authorization: `Bearer ${f.created.key}` } })).status, 405);
  const crossSite = await fetch(`${f.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", authorization: `Bearer ${f.created.key}` }, body: "{}" });
  assert.equal(crossSite.status, 403);

  const init = await f.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal(init.body.result.serverInfo.version, "9.9.9");
  assert.deepEqual(init.body.result.capabilities, { tools: {} });
  assert.equal((await f.rpc("initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion, "2025-11-25");
  const notified = await fetch(`${f.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.created.key}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(notified.status, 202);
  const tools = (await f.rpc("tools/list")).body.result.tools as Array<{ name: string; inputSchema: { type: string } }>;
  assert.deepEqual(tools.map(tool => tool.name), ["list_broadcasts", "chat_activity", "get_chat", "search_chat", "top_chatters"]);
  assert.ok(tools.every(tool => tool.inputSchema.type === "object"));
  assert.equal((await f.rpc("no/such")).body.error.code, -32601);

  const stored = await readFile(path.join(f.directories.config, "mcp-keys.json"), "utf8");
  assert.equal(stored.includes(f.created.key), false, "only a hash of the key is stored");
  assert.equal(await f.keys.revoke(f.created.id), true);
  assert.equal((await f.rpc("tools/list")).status, 401);
});

test("MCP tools list broadcasts, find the busiest span and read chat without leaking raw extras", async t => {
  const f = await fixture(t);
  const list = await f.call("list_broadcasts", { from: "2026-11-18", to: "2026-11-18" });
  assert.match(list.text, new RegExp(`id: ${f.id}`));
  assert.match(list.text, /채팅 35건 · 참여자 4명/);
  assert.match(list.text, /제목: 합성 방송 제목 · session_id: 777/);
  assert.match(list.text, /시작: 2026-11-18 20:00:00 KST/);
  assert.match((await f.call("list_broadcasts", { from: "2026-11-01", to: "2026-11-02" })).text, /저장된 방송이 없습니다/);

  const activity = await f.call("chat_activity", { broadcast: f.id, bucket_minutes: 5, top: 2 });
  assert.match(activity.text, /전체 35건/);
  assert.match(activity.text, /1\. 2026-11-18 20:10:00~20:15\s+31건/);

  const peak = await f.call("get_chat", { broadcast: f.id, from: "2026-11-18 20:10", to: "2026-11-18 20:15", limit: 10 });
  assert.match(peak.text, /조건에 맞는 채팅 31건 중 1~10번째/);
  assert.match(peak.text, /이어 읽기: offset=10/);
  assert.match(peak.text, /\[20:10:00\] 다: 몰아치기 0/);
  const rest = await f.call("get_chat", { broadcast: f.id, from: "2026-11-18 20:10", to: "2026-11-18 20:15", offset: 30 });
  assert.match(rest.text, /\[20:11:40\] \(후원\) 익명: 후원합니다/);
  assert.match(rest.text, /끝까지 읽었습니다/);
  const whole = await f.call("get_chat", { broadcast: f.id, user_tags: true });
  assert.match(whole.text, /\[20:00:30\] 나#[0-9a-f]{6}: 안녕하세요 \{:hi:\}/);
  assert.doesNotMatch(whole.text, /secret-hash|synthetic-secret-token|extras/);

  const search = await f.call("search_chat", { query: "마무리", from: "2026-11-18", to: "2026-11-18" });
  assert.match(search.text, /1건 일치/);
  assert.match(search.text, /\[2026-11-18 21:00:00\] 나: 마무리/);
  assert.equal((await f.call("search_chat", {})).isError, true);

  const chatters = await f.call("top_chatters", { broadcast: f.id, limit: 2 });
  assert.match(chatters.text, /1\. 가#[0-9a-f]{6}\s+17건/);
  assert.match(chatters.text, /후원 1/);

  for (const bad of ["../config/admin.json", ".chzzk-index/chat.sqlite", "시험방송/nope.jsonl", 5]) {
    assert.equal((await f.call("get_chat", { broadcast: bad })).isError, true);
  }
  assert.equal((await f.call("list_broadcasts", { streamer: "../config" })).isError, true);
  assert.equal((await f.call("no_such_tool", {})).isError, true);
});

test("admin ids may be email addresses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-admin-email-"));
  await createAdmin(root, "admin@example.com", "long-test-password");
  assert.equal(await verifyAdmin(root, "admin@example.com", "long-test-password"), true);
  await assert.rejects(() => createAdmin(root, "bad name", "long-test-password"), /아이디는/);
});
