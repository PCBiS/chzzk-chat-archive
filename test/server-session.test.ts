import test from "node:test";
import assert from "node:assert/strict";
import { sessionCookie } from "../src/server";

test("uses a browser-session cookie without a persistent expiration", () => {
  const cookie = sessionCookie(false);

  assert.deepEqual(cookie, {
    httpOnly: true,
    sameSite: "strict",
    secure: false
  });
  assert.equal("maxAge" in cookie, false);
  assert.equal("expires" in cookie, false);
});

test("marks the session cookie secure behind a trusted HTTPS proxy", () => {
  assert.equal(sessionCookie(true).secure, true);
});
