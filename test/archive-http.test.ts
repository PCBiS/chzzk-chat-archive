import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ArchiveStore } from "../src/archive-store";
import { ChatIndex } from "../src/chat-index";
import { createServer } from "../src/server";
import { OperationalLogger } from "../src/logs";
import type { CrawlerManager } from "../src/crawler";
import type { ArchiveRecord } from "../src/types";

function record(message: string): ArchiveRecord {
  return {
    schemaVersion: 1, recordedAt: "2026-07-30T00:00:00.000Z", messageAt: "2026-07-30T00:00:00.000Z",
    streamer: { channelId: "synthetic-channel", name: "시험 방송" },
    broadcast: { sessionId: "1", title: "시험", openedAt: "2026-07-30T00:00:00.000Z", kind: "live" },
    event: "chat", user: { id: "synthetic-user", nickname: "시험사용자" }, message, hidden: false, recent: false
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archive-http-"));
  const directories = Object.fromEntries(["config", "data", "logs", "public"].map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(directories).map(directory => mkdir(directory)));
  const store = new ArchiveStore(directories.data);
  await store.init();
  const index = await ChatIndex.open(directories.data, store);
  const app = createServer({
    configDir: directories.config, dataDir: directories.data, logsDir: directories.logs, publicDir: directories.public,
    sessionSecret: "synthetic-archive-http-session-secret-00000000", trustProxy: false,
    crawler: { snapshots: () => [] } as unknown as CrawlerManager,
    chatIndex: index, archiveStore: store, logger: new OperationalLogger(directories.logs)
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    index.close(); store.close(); await rm(root, { recursive: true, force: true });
  });
  const credentials = { username: "fixture-admin", password: "Synthetic-Test-Password-2026!" };
  const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials) });
  assert.equal(setup.status, 201); await setup.arrayBuffer();
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const session = await login.json() as { csrf: string };
  async function archive(id: string, content: string) {
    await writeFile(path.join(directories.data, id), content);
    await index.syncFile(id);
    const old = new Date(Date.now() - 8 * 86400000);
    await utimes(path.join(directories.data,id), old, old);
    await store.registerClosed(id, { channelId: "synthetic-channel", sessionId: "1", successorId: "2", lastRecordAt: old.valueOf() });
    assert.equal((await store.compress(id)).compressed, true);
  }
  return { base, cookie, csrf: session.csrf, store, index, archive, directories };
}

test("compressed archive HTTP browsing, search, downloads, rebuild authorization and deletion", async t => {
  const f = await fixture(t);
  const id = "sample.jsonl";
  const content = [record("한글 😀 첫 채팅"), record("두 번째 채팅")].map(item => JSON.stringify(item)).join("\n") + "\n";
  await f.archive(id, content);
  const headers = { cookie: f.cookie };
  const originalRead = fs.createReadStream;
  let gzipReads = 0;
  t.mock.method(fs, "createReadStream", (...args: Parameters<typeof fs.createReadStream>) => {
    if (String(args[0]).endsWith(".gz")) gzipReads += 1;
    return originalRead(...args);
  });

  assert.equal((await fetch(`${f.base}/api/files`)).status, 401);
  for (let n = 0; n < 3; n += 1) {
    const listing = await fetch(`${f.base}/api/files`, { headers });
    assert.equal(listing.status, 200);
    const items = await listing.json() as Array<{path: string; encoding: string; rawSize: number}>;
    assert.equal(items.length, 1); assert.equal(items[0].path, id);
    assert.equal(items[0].encoding, "gzip"); assert.equal(items[0].rawSize, Buffer.byteLength(content));
    const result = await fetch(`${f.base}/api/analysis?path=${id}&q=${encodeURIComponent("첫 채팅")}`, { headers });
    assert.equal(result.status, 200);
    const analysis = await result.json() as { totalMessages: number; filteredMessages: number; messages: ArchiveRecord[] };
    assert.equal(analysis.totalMessages, 2); assert.equal(analysis.filteredMessages, 1);
    assert.equal(analysis.messages[0].message, "한글 😀 첫 채팅");
  }
  assert.equal(gzipReads, 0, "metadata browsing and indexed search must not open gzip bodies");
  const raw = await fetch(`${f.base}/api/files/download?path=${id}`, { headers });
  assert.equal(raw.status, 200); assert.equal(await raw.text(), content);
  assert.match(raw.headers.get("content-disposition")!, /sample\.jsonl/);
  const packed = await fetch(`${f.base}/api/files/download?path=${id}&format=gzip`, { headers });
  assert.equal(packed.status, 200);
  const packedBytes = Buffer.from(await packed.arrayBuffer());
  assert.deepEqual(packedBytes, await readFile(path.join(f.directories.data, `${id}.gz`)));
  assert.equal(gunzipSync(packedBytes).toString(), content);

  const unauthorized = await fetch(`${f.base}/api/analysis/rebuild`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ path: id }) });
  assert.equal(unauthorized.status, 403); await unauthorized.arrayBuffer();
  f.index.removeFile(id);
  const missing = await fetch(`${f.base}/api/analysis?path=${id}`, { headers });
  assert.equal(missing.status, 400); await missing.arrayBuffer();
  const rebuild = await fetch(`${f.base}/api/analysis/rebuild`, { method: "POST", headers: { ...headers, "content-type": "application/json", "x-csrf-token": f.csrf }, body: JSON.stringify({ path: id }) });
  assert.equal(rebuild.status, 200); await rebuild.arrayBuffer();
  const recovered = await fetch(`${f.base}/api/analysis?path=${id}`, { headers });
  assert.equal(recovered.status, 200); assert.equal((await recovered.json() as {totalMessages: number}).totalMessages, 2);
  const forbiddenDelete = await fetch(`${f.base}/api/files?path=${id}`, { method: "DELETE", headers });
  assert.equal(forbiddenDelete.status, 403); await forbiddenDelete.arrayBuffer();
  const deleted = await fetch(`${f.base}/api/files?path=${id}`, { method: "DELETE", headers: { ...headers, "x-csrf-token": f.csrf } });
  assert.equal(deleted.status, 204);
  assert.equal(f.store.getState(id)?.state, "DELETED");
});

test("aborting a gzip-to-JSONL download releases its archive lease", async t => {
  const f = await fixture(t);
  const id = "large.jsonl";
  // Random synthetic payload prevents the whole transfer fitting in a socket buffer.
  const content = Array.from({length: 6000}, () => JSON.stringify(record(randomBytes(600).toString("hex")))).join("\n") + "\n";
  await f.archive(id, content);
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(`${f.base}/api/files/download?path=${id}`, { headers: {cookie: f.cookie} }, response => {
      response.once("data", () => { response.destroy(); request.destroy(); resolve(); });
      response.once("error", () => {});
    });
    request.once("error", reject); request.end();
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      f.store.withFile(id, async () => {}),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("download retained its file lease after cancellation")), 3000); })
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
  assert.equal((await f.store.resolve(id)).encoding, "gzip");
});
