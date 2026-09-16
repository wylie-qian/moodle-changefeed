import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { createBrowserLoginSession, consumeBrowserLoginCallback, readHiddenInput, readWebServiceToken } from "../src/auth/browser-login.mjs";

const token = "a".repeat(32);
function callback(session, { site = session.siteUrl, privateToken = true } = {}) {
  const passport = new URL(session.launchUrl).searchParams.get("passport");
  const hash = createHash("md5").update(site + passport).digest("hex");
  return `moodlemobile://token=${Buffer.from(`${hash}:::${token}${privateToken ? `:::${"b".repeat(32)}` : ""}`).toString("base64")}`;
}
function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  input.pause();
  const output = { isTTY: true, text: "", write(text) { this.text += text; } };
  return { input, output };
}

test("launch preserves HTTPS site subpath and creates independent ten minute sessions", () => {
  const first = createBrowserLoginSession({ siteUrl: "https://school.example/moodle/", now: 1000 });
  const second = createBrowserLoginSession({ siteUrl: first.siteUrl, now: 1000 });
  const url = new URL(first.launchUrl);
  assert.equal(url.pathname, "/moodle/admin/tool/mobile/launch.php");
  assert.equal(url.searchParams.get("service"), "moodle_mobile_app");
  assert.equal(url.searchParams.get("confirmed"), "1");
  assert.equal(first.expiresAt, 601000);
  assert.notEqual(first.launchUrl, second.launchUrl);
  assert.ok(Object.isFrozen(first));
});
test("valid callbacks discard private token and cannot be replayed", () => {
  for (const privateToken of [true, false]) {
    const session = createBrowserLoginSession({ siteUrl: "https://school.example", now: 0 });
    assert.deepEqual(consumeBrowserLoginCallback(session, callback(session, { privateToken }), { now: 1 }), { webServiceToken: token });
    assert.throws(() => consumeBrowserLoginCallback(session, callback(session), { now: 1 }), { code: "login_session_invalid" });
  }
});
test("rejects changed sites, sessions, expiration, and invalid schemes without input disclosure", () => {
  const session = createBrowserLoginSession({ siteUrl: "https://school.example/path", now: 0 });
  const other = createBrowserLoginSession({ siteUrl: session.siteUrl, now: 0 });
  for (const raw of [callback(other), callback(session, { site: "https://other.example" }), "https://token=secret", "moodlemobile://token=%%%%", "x".repeat(4097)]) {
    assert.throws(() => consumeBrowserLoginCallback(session, raw, { now: 1 }), (error) => {
      assert.ok(error.code.startsWith("login_callback_"));
      assert.ok(!String(error).includes(raw));
      return true;
    });
  }
  assert.throws(() => consumeBrowserLoginCallback({ ...session }, callback(session), { now: 1 }), { code: "login_session_invalid" });
  assert.throws(() => consumeBrowserLoginCallback(session, callback(session), { now: 600000 }), { code: "login_session_expired" });
  assert.throws(() => createBrowserLoginSession({ siteUrl: "http://secret:password@school.example" }), (error) => !String(error).includes("password"));
});
test("rejects malformed token structures", () => {
  const session = createBrowserLoginSession({ siteUrl: "https://school.example", now: 0 });
  for (const decoded of ["abc", `${"a".repeat(32)}:::bad`, `${"a".repeat(32)}:::${token}:::bad`]) {
    assert.throws(() => consumeBrowserLoginCallback(session, `moodlemobile://token=${Buffer.from(decoded).toString("base64")}`, { now: 1 }), { code: "login_callback_invalid" });
  }
});
test("hidden token entry never echoes input and restores terminal state", async () => {
  const tty = terminal();
  const pending = readWebServiceToken({ ...tty, prompt: "Token: " });
  tty.input.write(`${token}\r`);
  assert.equal(await pending, token);
  assert.equal(tty.output.text, "Token: \n");
  assert.equal(tty.input.isRaw, false);
  assert.ok(tty.input.isPaused());
  assert.equal(tty.input.listenerCount("data"), 0);
});
test("hidden input handles cancellation, EOF, excessive input and abort", async () => {
  for (const action of ["ctrl-c", "ctrl-d", "end", "long", "abort"]) {
    const tty = terminal();
    const controller = new AbortController();
    const pending = readHiddenInput({ ...tty, maxLength: 8, signal: controller.signal });
    if (action === "abort") controller.abort();
    else if (action === "end") tty.input.end();
    else tty.input.write(action === "long" ? "123456789" : action === "ctrl-c" ? "\u0003" : "\u0004");
    await assert.rejects(pending, { code: action === "long" ? "login_input_too_long" : "login_cancelled" });
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.input.listenerCount("data"), 0);
    assert.ok(!tty.output.text.includes("123456789"));
  }
  await assert.rejects(readHiddenInput({ input: { isTTY: false } }), { code: "login_tty_required" });
});
