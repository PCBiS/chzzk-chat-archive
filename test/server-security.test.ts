import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { deflateSync, gzipSync } from "node:zlib";

interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

async function isolatedServer(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-server-security-"));
  const child = fork(path.join(__dirname, "security-server-fixture.js"), [root], { silent: true });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_384); });
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Test server did not start: ${output}`)), 10_000);
    const onExit = () => {
      clearTimeout(timeout);
      reject(new Error(`Test server exited before startup: ${output}`));
    };
    const onError = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    child.once("message", (message: unknown) => {
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      const port = (message as { port?: unknown }).port;
      if (typeof port !== "number") return reject(new Error("Test server did not report its port"));
      resolve(port);
    });
  });
  return {
    async request(
      method: string,
      route: string,
      body?: Buffer,
      headers: Record<string, string> = {}
    ): Promise<HttpResponse> {
      return new Promise((resolve, reject) => {
        const request = http.request({
          hostname: "127.0.0.1",
          port,
          method,
          path: route,
          agent: false,
          headers: {
            ...(body ? { "Content-Type": "application/json", "Content-Length": body.length } : {}),
            ...headers
          }
        }, (response) => {
          let received = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => { received += chunk; });
          response.once("error", reject);
          response.once("end", () => resolve({
            status: response.statusCode!, headers: response.headers, body: received
          }));
        });
        request.setTimeout(5_000, () => request.destroy(new Error("Loopback test request timed out")));
        request.once("error", (error) => reject(new Error(`${error.message}\nChild output: ${output}`)));
        request.end(body);
      });
    },
    assertRunning() {
      assert.equal(child.exitCode, null, `Test server terminated: ${output}`);
      assert.equal(child.signalCode, null, `Test server was killed: ${output}`);
    }
  };
}

test("plain JSON setup and gzip login preserve authentication and CSRF protection", { timeout: 20_000 }, async (context) => {
  const server = await isolatedServer(context);
  assert.equal((await server.request("GET", "/api/status")).status, 401);
  const credentials = Buffer.from(JSON.stringify({ username: "security-test", password: "local-test-password" }));
  assert.equal((await server.request("POST", "/api/auth/setup", credentials)).status, 201);
  const login = await server.request("POST", "/api/auth/login", gzipSync(credentials), { "Content-Encoding": "gzip" });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]?.map((value) => value.split(";", 1)[0]).join("; ") || "";
  assert.match(cookie, /chzzk_archive_sid=/);
  const csrf = JSON.parse(login.body).csrf;
  assert.equal(typeof csrf, "string");
  assert.equal((await server.request("GET", "/api/status", undefined, { Cookie: cookie })).status, 200);
  assert.equal((await server.request("POST", "/api/auth/logout", Buffer.from("{}"), { Cookie: cookie })).status, 403);
  assert.equal((await server.request("POST", "/api/auth/logout", Buffer.from("{}"), {
    Cookie: cookie, "X-CSRF-Token": csrf
  })).status, 204);
  assert.equal((await server.request("GET", "/api/status", undefined, { Cookie: cookie })).status, 401);
});

// GHSA-27r3-jxmh-p828: the compressed JSON can finish before the HTTP body.
// Extra encoded bytes must never produce a late uncaught decompressor error.
// Exercise the actual application before authentication, exclusively on loopback.
for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync]] as const) {
  test(`survives unauthenticated ${encoding} bodies with trailing bytes`, { timeout: 20_000 }, async (context) => {
    const server = await isolatedServer(context);
    const frame = compress(Buffer.from('{"probe":true}'));
    const valid = await server.request("PUT", "/api/settings", frame, { "Content-Encoding": encoding });
    assert.equal(valid.status, 401);
    const malformed = Buffer.concat([frame, Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
    const response = await server.request("PUT", "/api/settings", malformed, { "Content-Encoding": encoding });
    // zlib versions differ in whether they accept or reject trailing data.
    assert.ok([400, 401].includes(response.status), `Unexpected status ${response.status}`);
    await delay(200);
    server.assertRunning();
    const health = await server.request("GET", "/healthz");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
    assert.equal((await server.request("GET", "/api/status")).status, 401);
  });
}
