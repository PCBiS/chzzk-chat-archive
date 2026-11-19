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

test("chat analysis loads the whole result and opens straight from the explorer", async () => {
  const source = await readFile(path.resolve(__dirname, "../../public/app.js"), "utf8");
  const html = await readFile(path.resolve(__dirname, "../../public/index.html"), "utf8");

  assert.match(source, /limit: "all"/);
  assert.doesNotMatch(html, /message-limit/);
  assert.match(source, /if \(open\) return void analyze\(open\.dataset\.open\);/);
  // Chat text and emoji must be inserted as DOM nodes, never as markup.
  assert.doesNotMatch(source, /message-list"\)\.innerHTML = result/);
});

test("cookie export files yield only the two login cookies for naver.com", () => {
  const { parseCookieFile } = require(path.resolve(__dirname, "../../public/cookie-file.js")) as {
    parseCookieFile(text: string): { NID_AUT: string; NID_SES: string; missing: string[]; expiresAt: string | null };
  };
  const netscape = [
    "# Netscape HTTP Cookie File", "# https://curl.haxx.se/rfc/cookie_spec.html", "",
    ".naver.com\tTRUE\t/\tFALSE\t1800000000\tNNB\tSYNTHETICNNB",
    "#HttpOnly_.naver.com\tTRUE\t/\tTRUE\t1790000000\tNID_AUT\tsyntheticAut+/=",
    "#HttpOnly_.naver.com\tTRUE\t/\tTRUE\t1795000000\tNID_SES\tsyntheticSes+/=",
    ".example.com\tTRUE\t/\tTRUE\t1790000000\tNID_AUT\tfromAnotherSite",
    "#HttpOnly_.evilnaver.com\tTRUE\t/\tTRUE\t1790000000\tNID_SES\tlookalike"
  ].join("\r\n");
  assert.deepEqual(parseCookieFile(netscape), {
    NID_AUT: "syntheticAut+/=", NID_SES: "syntheticSes+/=", missing: [], expiresAt: new Date(1790000000 * 1000).toISOString()
  });
  const json = JSON.stringify([
    { domain: ".naver.com", name: "NID_AUT", value: "jsonAut", expirationDate: 1790000000.5 },
    { domain: "chzzk.naver.com", name: "NID_SES", value: "jsonSes" }
  ]);
  assert.equal(parseCookieFile(json).NID_SES, "jsonSes");
  assert.deepEqual(parseCookieFile(json).missing, []);
  assert.deepEqual(parseCookieFile(".naver.com\tTRUE\t/\tTRUE\t0\tNID_AUT\tonly").missing, ["NID_SES"]);
  assert.deepEqual(parseCookieFile("not a cookie file").missing, ["NID_AUT", "NID_SES"]);
  assert.equal(parseCookieFile(".naver.com\tTRUE\t/\tTRUE\t0\tNID_AUT\tbad value; x").NID_AUT, "");
});
