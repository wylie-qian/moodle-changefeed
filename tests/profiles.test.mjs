import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProfileRoot, getAccountDataDir, loadProfile, saveVerifiedProfile } from "../src/auth/profiles.mjs";

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moodle-profiles-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { name: "student", siteUrl: "https://example.edu/moodle/", userId: 42, token: "synthetic-test-token", profileRoot: path.join(root, "profiles"), dataRoot: path.join(root, "accounts") };
}

test("verified profiles roundtrip without serializing credentials", async t => {
  const options = setup(t);
  const saved = saveVerifiedProfile(options);
  const loaded = loadProfile(options);
  assert.equal(loaded.siteUrl, "https://example.edu/moodle");
  assert.equal(loaded.userId, 42);
  assert.equal(await loaded.credentialProvider.getWebServiceToken(), options.token);
  assert.equal(await loaded.credentialProvider.getIcsUrl(), null);
  assert.equal(loaded.credentialProvider.siteKey, loaded.siteUrl);
  assert.equal(JSON.stringify(saved).includes(options.token), false);
  assert.equal(JSON.stringify(loaded).includes(options.token), false);
  assert.equal(loaded.dataDir.startsWith(options.profileRoot), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(options.profileRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(options.profileRoot, "student.json")).mode & 0o777, 0o600);
  }
});

test("profiles bind site and user while permitting same account token rotation", async t => {
  const options = setup(t);
  saveVerifiedProfile(options);
  assert.throws(() => saveVerifiedProfile({ ...options, userId: 43 }), /new profile name/);
  assert.throws(() => saveVerifiedProfile({ ...options, siteUrl: "https://other.edu" }), /new profile name/);
  saveVerifiedProfile({ ...options, token: "short" });
  assert.equal(await loadProfile(options).credentialProvider.getWebServiceToken(), "short");
  assert.notEqual(getAccountDataDir(options), getAccountDataDir({ ...options, userId: 43 }));
  assert.notEqual(getAccountDataDir(options), getAccountDataDir({ ...options, siteUrl: "https://other.edu" }));
  assert.equal(getAccountDataDir(options), getAccountDataDir({ ...options, siteUrl: "https://example.edu/moodle" }));
});

test("profile names cannot escape storage and IDs must be verified numeric IDs", t => {
  const options = setup(t);
  for (const name of ["../outside", "", "/absolute", "x/y", "x\\y", ".hidden"]) {
    assert.throws(() => saveVerifiedProfile({ ...options, name }), /Profile name/);
  }
  for (const userId of [0, -1, "student", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => saveVerifiedProfile({ ...options, userId }), /user ID/);
  }
});

test("unsafe permissions and symlinks fail closed", { skip: process.platform === "win32" }, t => {
  const options = setup(t);
  saveVerifiedProfile(options);
  const file = path.join(options.profileRoot, "student.json");
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadProfile(options), /permissions/);
  assert.throws(() => saveVerifiedProfile(options), /permissions/);
  fs.chmodSync(file, 0o600);
  fs.chmodSync(options.profileRoot, 0o755);
  assert.throws(() => loadProfile(options), /permissions/);
  fs.chmodSync(options.profileRoot, 0o700);
  const other = path.join(options.profileRoot, "other.json");
  fs.renameSync(file, other);
  fs.symlinkSync(other, file);
  assert.throws(() => loadProfile(options), /symbolic links/);
  assert.throws(() => saveVerifiedProfile(options), /symbolic links/);
});

test("platform paths honor local user directories and profile override", () => {
  assert.equal(getProfileRoot({ platform: "darwin", home: "/users/test", env: {} }), "/users/test/Library/Application Support/moodle-changefeed/profiles");
  assert.equal(getProfileRoot({ platform: "linux", home: "/users/test", env: { XDG_DATA_HOME: "/custom" } }), "/custom/moodle-changefeed/profiles");
  assert.equal(getProfileRoot({ platform: "win32", home: "C:\\Users\\test", env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" } }), "C:\\Users\\test\\AppData\\Local\\moodle-changefeed\\profiles");
  assert.equal(getProfileRoot({ env: { MOODLE_CHANGEFEED_PROFILE_ROOT: "/override" } }), "/override");
});


test("running providers pick up renewal but cannot silently switch accounts", async t => {
  const options = setup(t);
  saveVerifiedProfile(options);
  const loaded = loadProfile(options);
  saveVerifiedProfile({ ...options, token: "renewed-synthetic" });
  assert.equal(await loaded.credentialProvider.getWebServiceToken(), "renewed-synthetic");
  const file = path.join(options.profileRoot, "student.json");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({...stored, userId: 99}));
  await assert.rejects(loaded.credentialProvider.getWebServiceToken(), /identity changed/);
});
