import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

function submitHandler(source: string, formId: string, nextFormId: string) {
  const start = source.indexOf(`$("#${formId}").addEventListener("submit"`);
  const end = source.indexOf(`$("#${nextFormId}")`, start + 1);
  assert.notEqual(start, -1, `${formId} submit handler should exist`);
  assert.notEqual(end, -1, `${formId} submit handler should have an end marker`);
  return source.slice(start, end);
}

test("async authentication handlers retain their form before awaiting", async () => {
  const source = await readFile(path.resolve(__dirname, "../../public/app.js"), "utf8");
  const setup = submitHandler(source, "setup-form", "login-form");
  const login = submitHandler(source, "login-form", "logout-button");

  for (const [name, handler] of [["setup", setup], ["login", login]] as const) {
    const firstAwait = handler.indexOf("await ");
    assert.notEqual(firstAwait, -1, `${name} handler should await its API request`);
    assert.match(handler.slice(0, firstAwait), /const formElement = event\.currentTarget;/);
    assert.doesNotMatch(
      handler.slice(firstAwait),
      /event\.currentTarget/,
      `${name} handler must not read Event.currentTarget after await`
    );
  }
});

test("chat analysis sends the selected message limit", async () => {
  const source = await readFile(path.resolve(__dirname, "../../public/app.js"), "utf8");
  const html = await readFile(path.resolve(__dirname, "../../public/index.html"), "utf8");

  assert.match(source, /limit: \$\("#message-limit"\)\.value/);
  assert.doesNotMatch(source, /message-load-more/);
  assert.match(html, /<option value="200" selected>200개<\/option>/);
  assert.match(html, /<option value="500">500개<\/option>/);
  assert.match(html, /<option value="1000">1,000개<\/option>/);
  assert.match(html, /<option value="all">전부<\/option>/);
});
