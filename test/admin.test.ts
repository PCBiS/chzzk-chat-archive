import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adminExists, createAdmin, ensureSessionSecret, verifyAdmin } from "../src/admin";

test("forces one-time admin setup and stores only a password hash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-admin-"));
  assert.equal(await adminExists(root), false);
  await createAdmin(root, "archive-admin", "long-test-password");
  assert.equal(await adminExists(root), true);
  assert.equal(await verifyAdmin(root, "archive-admin", "long-test-password"), true);
  assert.equal(await verifyAdmin(root, "archive-admin", "wrong-password"), false);
  const stored = await readFile(path.join(root, "admin.json"), "utf8");
  assert.equal(stored.includes("long-test-password"), false);
  await assert.rejects(() => createAdmin(root, "other-admin", "another-password"));
});

test("accepts six-character passwords and rejects shorter ones", async () => {
  const acceptedRoot = await mkdtemp(path.join(os.tmpdir(), "chzzk-admin-"));
  await createAdmin(acceptedRoot, "six-user", "123456");
  assert.equal(await verifyAdmin(acceptedRoot, "six-user", "123456"), true);
  const rejectedRoot = await mkdtemp(path.join(os.tmpdir(), "chzzk-admin-"));
  await assert.rejects(() => createAdmin(rejectedRoot, "short-user", "12345"));
});

test("creates and reuses a persistent session secret", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chzzk-admin-"));
  const first = await ensureSessionSecret(root);
  const second = await ensureSessionSecret(root);
  assert.equal(first.length >= 32, true);
  assert.equal(second, first);
});
