import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalSiteKey, sha256Hex } from "../core/contracts.mjs";

function applicationRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "moodle-changefeed");
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "moodle-changefeed");
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, ".local", "share"), "moodle-changefeed");
}

export function getProfileRoot(options = {}) {
  const env = options.env || process.env;
  const paths = (options.platform || process.platform) === "win32" ? path.win32 : path.posix;
  return env.MOODLE_CHANGEFEED_PROFILE_ROOT || paths.join(applicationRoot(options), "profiles");
}

function validateName(name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new TypeError("Profile name must contain 1-64 letters, digits, underscores or hyphens and start with a letter or digit");
  }
  return name;
}

function identity(siteUrl, userId) {
  if (!/^[1-9][0-9]*$/.test(String(userId)) || !Number.isSafeInteger(Number(userId))) {
    throw new TypeError("A verified positive Moodle user ID is required");
  }
  return { siteUrl: canonicalSiteKey(siteUrl), userId: Number(userId) };
}

export function getAccountDataDir({ siteUrl, userId, dataRoot = path.join(applicationRoot(), "accounts") }) {
  const account = identity(siteUrl, userId);
  return path.join(path.resolve(dataRoot), sha256Hex(JSON.stringify([account.siteUrl, account.userId])));
}

// POSIX permissions restrict local access; Windows inherits the user's directory ACL.
// This is private local storage, not encryption or an OS credential vault.
function assertPrivate(target, directory) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error("Profile storage must use regular files and directories, not symbolic links");
  }
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) {
    throw new Error("Unsafe profile storage ownership or permissions; use 0700 directories and 0600 files");
  }
}

function rejectSymlinkAncestors(target) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    // macOS /tmp and /var are platform aliases; resolve their ancestors, but reject
    // symlinks at the storage root and below via assertPrivate/open(O_NOFOLLOW).
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() && current !== "/tmp" && current !== "/var") {
        throw new Error("Profile storage path must not contain symbolic links");
      }
    }
    if (path.dirname(current) === current) break;
  }
}

function profilePath(name, profileRoot, create = false) {
  validateName(name);
  const root = path.resolve(profileRoot || getProfileRoot());
  rejectSymlinkAncestors(root);
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivate(root, true);
  return path.join(root, `${name}.json`);
}

function readSecret(file) {
  assertPrivate(file, false);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
      throw new Error("Unsafe profile file permissions");
    }
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(fd, "utf8")); } catch { throw new Error("Invalid profile file"); }
    if (parsed.version !== 1 || typeof parsed.token !== "string" || !parsed.token.trim()) throw new Error("Invalid profile file");
    return { ...identity(parsed.siteUrl, parsed.userId), token: parsed.token };
  } finally { fs.closeSync(fd); }
}

function publicProfile(name, secret, dataRoot) {
  const { siteUrl, userId, token } = secret;
  return {
    name, siteUrl, userId, dataDir: getAccountDataDir({ siteUrl, userId, dataRoot }),
    credentialProvider: {
      siteKey: siteUrl,
      async getWebServiceToken() { return token; },
      async getIcsUrl() { return null; }
    }
  };
}

export function loadProfile({ name, profileRoot, dataRoot }) {
  const file = profilePath(name, profileRoot);
  const original = readSecret(file);
  const profile = publicProfile(validateName(name), original, dataRoot);
  profile.credentialProvider.getWebServiceToken = async () => {
    // Allow token renewal in a running MCP connection without switching identities.
    assertPrivate(path.dirname(file), true);
    const current = readSecret(file);
    if (current.siteUrl !== original.siteUrl || current.userId !== original.userId) {
      throw new Error("Profile identity changed; reconnect using the correct profile");
    }
    return current.token;
  };
  return profile;
}

// The caller must first verify this token and user ID with core_webservice_get_site_info.
// Never persist an unverified login response or infer the account from a username.
export function saveVerifiedProfile({ name, siteUrl, userId, token, profileRoot, dataRoot }) {
  const account = identity(siteUrl, userId);
  if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) throw new TypeError("A verified token is required");
  const file = profilePath(name, profileRoot, true);
  let exists = false;
  try { fs.lstatSync(file); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (exists) {
    const previous = readSecret(file);
    if (previous.siteUrl !== account.siteUrl || previous.userId !== account.userId) {
      throw new Error("This profile belongs to another Moodle site or account; choose a new profile name");
    }
  }
  const secret = { version: 1, ...account, token };
  // Exclusive creation also keeps parallel initial logins from replacing one another.
  const flags = exists ? fs.constants.O_WRONLY : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  const fd = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw new Error("Unsafe profile file permissions");
    fs.writeFileSync(fd, `${JSON.stringify(secret)}\n`);
    fs.ftruncateSync(fd, Buffer.byteLength(`${JSON.stringify(secret)}\n`));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return publicProfile(name, secret, dataRoot);
}
