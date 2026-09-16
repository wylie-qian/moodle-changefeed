import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalSiteKey } from "../core/determinism.mjs";
import { ChangefeedError } from "../core/errors.mjs";

const sessions = new WeakMap();
const TOKEN = /^[a-f0-9]{32}$/i;
const MAX_CALLBACK_LENGTH = 4096;
const fail = (code, message) => new ChangefeedError(code, message);

// Protocol: moodle/moodle MOODLE_405_STABLE admin/tool/mobile/launch.php.
// Moodle may force a different app scheme; reject it instead of weakening binding.
export function createBrowserLoginSession({ siteUrl, now = Date.now() } = {}) {
  let site;
  try { site = canonicalSiteKey(siteUrl); } catch {
    throw fail("login_site_invalid", "A valid HTTPS Moodle site URL is required.");
  }
  if (!Number.isFinite(now)) throw fail("login_session_invalid", "Invalid login session clock.");
  const passport = randomBytes(32).toString("hex");
  const scheme = "moodlemobile";
  const url = new URL(`${site}/admin/tool/mobile/launch.php`);
  url.search = new URLSearchParams({ service: "moodle_mobile_app", passport, urlscheme: scheme, confirmed: "1" }).toString();
  const session = Object.freeze({ siteUrl: site, launchUrl: url.toString(), expiresAt: now + 600_000 });
  sessions.set(session, { site, passport, scheme, createdAt: now, used: false });
  return session;
}

export function consumeBrowserLoginCallback(session, callback, { now = Date.now() } = {}) {
  const state = sessions.get(session);
  if (!state || state.used) throw fail("login_session_invalid", "Login session is invalid or already used.");
  if (!Number.isFinite(now) || now < state.createdAt || now >= session.expiresAt) {
    state.used = true;
    throw fail("login_session_expired", "Login session expired. Start login again.");
  }
  if (typeof callback !== "string" || callback.length > MAX_CALLBACK_LENGTH) {
    throw fail("login_callback_invalid", "Invalid Moodle app callback.");
  }
  const match = callback.trim().match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/token=([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1] !== state.scheme) throw fail("login_callback_invalid", "Invalid Moodle app callback scheme or payload.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.toString("base64") !== match[2]) throw fail("login_callback_invalid", "Invalid Moodle app callback encoding.");
  const parts = bytes.toString("utf8").split(":::");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !TOKEN.test(part))) {
    throw fail("login_callback_invalid", "Invalid Moodle app callback token structure.");
  }
  const expected = createHash("md5").update(state.site + state.passport).digest();
  if (!timingSafeEqual(expected, Buffer.from(parts[0], "hex"))) {
    throw fail("login_callback_mismatch", "Callback does not match this site and login session.");
  }
  state.used = true;
  return { webServiceToken: parts[1] };
}

// No readline echo, shell arguments, clipboard access, or OS protocol registration.
export async function readHiddenInput({
  input = process.stdin, output = process.stderr, prompt = "Paste the secret in this terminal: ",
  maxLength = MAX_CALLBACK_LENGTH, signal
} = {}) {
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") {
    throw fail("login_tty_required", "Open an interactive local terminal to enter the credential privately.");
  }
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > MAX_CALLBACK_LENGTH) {
    throw fail("login_input_invalid", "Invalid input length limit.");
  }
  if (signal?.aborted) throw fail("login_cancelled", "Login cancelled.");
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = input.isPaused();
    let value = "";
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      input.removeListener("data", onData);
      input.removeListener("end", onCancel);
      input.removeListener("error", onError);
      signal?.removeEventListener("abort", onCancel);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write("\n");
      const result = value;
      value = "";
      if (error) reject(error); else resolve(result);
    };
    const onCancel = () => finish(fail("login_cancelled", "Login cancelled."));
    const onError = () => finish(fail("login_input_failed", "Unable to read private terminal input."));
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003" || character === "\u0004") return onCancel();
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") { value = value.slice(0, -1); continue; }
        if (character.charCodeAt(0) < 32 || character.charCodeAt(0) > 126) {
          return finish(fail("login_input_invalid", "Input must contain plain ASCII text."));
        }
        value += character;
        if (value.length > maxLength) return finish(fail("login_input_too_long", "Private input exceeds the length limit."));
      }
    };
    input.on("data", onData);
    input.on("end", onCancel);
    input.on("error", onError);
    signal?.addEventListener("abort", onCancel, { once: true });
    input.setRawMode(true);
    output.write(prompt);
    input.resume();
  });
}

export async function readWebServiceToken(options = {}) {
  const token = (await readHiddenInput({ ...options, maxLength: 128 })).trim();
  if (!TOKEN.test(token)) throw fail("login_token_invalid", "Expected a 32-character Moodle Web Service token.");
  return token;
}
