import os from "node:os";
import path from "node:path";

import { canonicalSiteKey } from "./core/contracts.mjs";

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_BATCH_BYTES = 500 * 1024 * 1024;

const VALUE_FLAGS = new Map([
  ["--site-url", "siteUrl"],
  ["--profile", "profile"],
  ["--data-dir", "dataDir"],
  ["--archive-root", "archiveRoot"],
  ["--domains", "domains"],
  ["--max-file-bytes", "maxFileBytes"],
  ["--max-batch-bytes", "maxBatchBytes"],
  ["--course-concurrency", "courseConcurrency"]
]);

function positiveInteger(value, label, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}
function resolveDirectory(value, cwd) {
  return path.resolve(cwd, value);
}

function defaultDataDir({ env, cwd }) {
  if (env.MOODLE_CHANGEFEED_DATA_DIR) {
    return resolveDirectory(env.MOODLE_CHANGEFEED_DATA_DIR, cwd);
  }
  const home = env.HOME || os.homedir();
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "moodle-changefeed");
  if (process.platform === "darwin" && home) {
    return path.join(home, "Library", "Application Support", "moodle-changefeed");
  }
  const xdg = env.XDG_DATA_HOME || (home ? path.join(home, ".local", "share") : cwd);
  return path.join(xdg, "moodle-changefeed");
}

function parseConfigArgv(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (/^--(?:token|moodle-token|webservice-token|ics-url)(?:=|$)/i.test(raw)) {
      throw new TypeError(
        "Moodle token and ICS URL must come from the environment or a credential provider"
      );
    }
    const equals = raw.indexOf("=");
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    const key = VALUE_FLAGS.get(flag);
    if (!key) throw new TypeError(`Unknown configuration option: ${flag}`);
    const value = equals > 0 ? raw.slice(equals + 1) : argv[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new TypeError(`${flag} requires a value`);
    }
    if (Object.hasOwn(values, key)) throw new TypeError(`${flag} may only be provided once`);
    values[key] = value;
  }
  return values;
}

function loadPublicConfigState({
  argv = [],
  env = process.env,
  cwd = process.cwd(),
  allowInvalidSite = false
} = {}) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const flags = parseConfigArgv(argv);
  const siteValue = flags.siteUrl || env.MOODLE_CHANGEFEED_SITE_URL || null;
  let siteUrl = null;
  let invalidSite = false;
  if (siteValue) {
    try {
      siteUrl = canonicalSiteKey(siteValue);
    } catch (error) {
      if (!allowInvalidSite) throw error;
      invalidSite = true;
    }
  }
  const dataDir = flags.dataDir
    ? resolveDirectory(flags.dataDir, cwd)
    : defaultDataDir({ env, cwd });
  const archiveRoot = resolveDirectory(
    flags.archiveRoot || env.MOODLE_CHANGEFEED_ARCHIVE_ROOT || path.join(dataDir, "archive"),
    cwd
  );
  const rawDomains = flags.domains || env.MOODLE_CHANGEFEED_DOMAINS ||
    "assignments,resources,announcements";
  const enabledDomains = [...new Set(rawDomains.split(",").map((value) => value.trim()).filter(Boolean))]
    .sort();
  const allowedDomains = new Set(["assignments", "resources", "announcements"]);
  if (enabledDomains.length === 0 || enabledDomains.some((value) => !allowedDomains.has(value))) {
    throw new TypeError("domains must contain assignments, resources, or announcements");
  }

  const publicConfig = Object.freeze({
    schemaVersion: 1,
    profile: flags.profile || env.MOODLE_CHANGEFEED_PROFILE || null,
    siteUrl,
    dataDir,
    archiveRoot,
    enabledDomains,
    maxFileBytes: positiveInteger(
      flags.maxFileBytes || env.MOODLE_CHANGEFEED_MAX_FILE_BYTES,
      "maxFileBytes",
      DEFAULT_MAX_FILE_BYTES
    ),
    maxBatchBytes: positiveInteger(
      flags.maxBatchBytes || env.MOODLE_CHANGEFEED_MAX_BATCH_BYTES,
      "maxBatchBytes",
      DEFAULT_MAX_BATCH_BYTES
    ),
    courseConcurrency: Math.min(
      4,
      positiveInteger(
        flags.courseConcurrency || env.MOODLE_CHANGEFEED_COURSE_CONCURRENCY,
        "courseConcurrency",
        2
      )
    ),
    writeEnabled: env.MOODLE_CHANGEFEED_WRITE_ENABLED === "true",
    credentialStatus: Object.freeze({
      webServiceToken: !invalidSite && env.MOODLE_CHANGEFEED_TOKEN ? "configured" : "missing",
      icsUrl: !invalidSite && env.MOODLE_CHANGEFEED_ICS_URL ? "configured" : "missing"
    })
  });
  return Object.freeze({ publicConfig, requestedSiteUrl: siteValue });
}

export function loadPublicConfig(options = {}) {
  return loadPublicConfigState(options).publicConfig;
}

export function loadEntryPublicConfig(options = {}) {
  return loadPublicConfigState({ ...options, allowInvalidSite: true });
}

export function createEnvironmentCredentialProvider(env = process.env) {
  return Object.freeze({
    siteKey: env.MOODLE_CHANGEFEED_SITE_URL
      ? canonicalSiteKey(env.MOODLE_CHANGEFEED_SITE_URL)
      : null,
    async getWebServiceToken() {
      return env.MOODLE_CHANGEFEED_TOKEN || null;
    },
    async getIcsUrl() {
      return env.MOODLE_CHANGEFEED_ICS_URL || null;
    }
  });
}
