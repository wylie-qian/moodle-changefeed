#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const EXPORT_REPORT_NAME = ".moodle-changefeed-export.json";
const TEXT_LIMIT_BYTES = 5 * 1024 * 1024;
const IMPORT_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/gu;

function finding(rule, filePath = null) {
  return filePath ? { rule, path: filePath } : { rule };
}

async function walkTree(root) {
  const files = [];
  const symlinks = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (relativeDirectory === "" && entry.name === ".git") continue;
      if (entry.name === "node_modules") continue;
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) symlinks.push(relativePath);
      else if (stat.isDirectory()) await visit(absolutePath, relativePath);
      else if (stat.isFile()) files.push(relativePath);
    }
  }
  await visit(root);
  return { files: files.sort(), symlinks: symlinks.sort() };
}

function flattenDenylist(value, output = []) {
  if (typeof value === "string" && value.length >= 4) output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => flattenDenylist(item, output));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => flattenDenylist(item, output));
  }
  return output;
}

async function loadDenylist(denylistPath, requireDenylist) {
  if (!denylistPath) {
    if (requireDenylist) {
      const error = new Error("MOODLE_CHANGEFEED_PUBLIC_DENYLIST_PATH is required");
      error.code = "public_denylist_required";
      throw error;
    }
    return [];
  }
  const parsed = JSON.parse(await readFile(path.resolve(denylistPath), "utf8"));
  return [...new Set(flattenDenylist(parsed))];
}

function inspectText(text, relativePath, publicRoot, denylist, findings) {
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /(?:api[_-]?key|app[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|password)\s*[=:]\s*["']?(?!\s*(?:example|placeholder|redacted|<[^>]+>|\$\{))[^\s"']{16,}/iu,
    /\b(?:sk|pat|ghp|github_pat)-[A-Za-z0-9_-]{24,}\b/u,
  ];
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    findings.push(finding("secret-pattern", relativePath));
  }
  if (/(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/u.test(text)) {
    findings.push(finding("absolute-user-path", relativePath));
  }
  if (denylist.some((value) => text.toLocaleLowerCase("en-US").includes(value.toLocaleLowerCase("en-US")))) {
    findings.push(finding("denylist-match", relativePath));
  }
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const sourceDirectory = path.dirname(path.join(publicRoot, ...relativePath.split("/")));
    const resolved = path.resolve(sourceDirectory, specifier.split(/[?#]/u, 1)[0]);
    const relative = path.relative(publicRoot, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      findings.push(finding("relative-import-outside-root", relativePath));
    }
  }
}

async function inspectGitMetadata(root, denylist, findings) {
  try {
    const gitStat = await lstat(path.join(root, ".git"));
    if (!gitStat) return;
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "log", "--format=%an%n%ae%n%cn%n%ce"],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    );
    inspectText(stdout, ".git/author-metadata", root, denylist, findings);
  } catch (error) {
    if (error?.code !== "ENOENT") findings.push(finding("git-metadata-unreadable"));
  }
}

async function npmPackFiles(root) {
  // Windows npm is a .cmd shim and cannot be spawned directly with execFile.
  // Use npm's JS entry when launched via npm, otherwise a fixed shell command.
  const npmEntry = process.env.npm_execpath;
  const executable = npmEntry ? process.execPath : process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
  const args = npmEntry ? [npmEntry, "pack", "--json", "--dry-run", "--ignore-scripts"]
    : process.platform === "win32" ? ["/d", "/s", "/c", "npm pack --json --dry-run --ignore-scripts"]
      : ["pack", "--json", "--dry-run", "--ignore-scripts"];
  const { stdout } = await execFileAsync(
    executable,
    args,
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: path.join(os.tmpdir(), "moodle-changefeed-npm-cache"),
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout);
  return (parsed[0]?.files ?? []).map((entry) => entry.path).sort();
}

function collectLicenseInventory(lock) {
  const inventory = {};
  for (const [packagePath, metadata] of Object.entries(lock?.packages ?? {})) {
    if (!packagePath.startsWith("node_modules/")) continue;
    const name = packagePath.slice("node_modules/".length);
    if (!name || name.includes("/node_modules/")) continue;
    inventory[name] = metadata?.license ?? "UNKNOWN";
  }
  return Object.entries(inventory)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, license]) => ({ name, license }));
}

export async function auditPublicTree({
  root,
  denylistPath,
  requireDenylist = false,
  checkManifest = true,
  checkPack = true,
} = {}) {
  const publicRoot = path.resolve(root);
  const findings = [];
  const denylist = await loadDenylist(denylistPath, requireDenylist);
  const tree = await walkTree(publicRoot);
  for (const symlink of tree.symlinks) findings.push(finding("symlink", symlink));

  for (const relativePath of tree.files) {
    const bytes = await readFile(path.join(publicRoot, ...relativePath.split("/")));
    if (bytes.byteLength > TEXT_LIMIT_BYTES || bytes.includes(0)) continue;
    inspectText(bytes.toString("utf8"), relativePath, publicRoot, denylist, findings);
  }
  await inspectGitMetadata(publicRoot, denylist, findings);

  let manifest = null;
  if (checkManifest || checkPack) {
    try {
      manifest = JSON.parse(await readFile(path.join(publicRoot, "public-manifest.json"), "utf8"));
    } catch {
      findings.push(finding("public-manifest-missing"));
    }
  }

  if (checkManifest && manifest) {
    const declared = new Set(manifest.repositoryFiles ?? []);
    const actual = tree.files.filter((filePath) => filePath !== EXPORT_REPORT_NAME);
    for (const filePath of actual) {
      if (!declared.has(filePath)) findings.push(finding("repository-file-omitted", filePath));
    }
    for (const filePath of [...declared].sort()) {
      if (!actual.includes(filePath)) findings.push(finding("repository-file-missing", filePath));
    }
  }

  let packFiles = [];
  if (checkPack && manifest) {
    try {
      packFiles = await npmPackFiles(publicRoot);
      const declared = new Set(manifest.packageFiles ?? []);
      const actual = new Set(packFiles);
      for (const filePath of packFiles) {
        if (!declared.has(filePath)) findings.push(finding("package-file-extra", filePath));
      }
      for (const filePath of [...declared].sort()) {
        if (!actual.has(filePath)) findings.push(finding("package-file-missing", filePath));
      }
    } catch {
      findings.push(finding("npm-pack-unreadable"));
    }
  }

  let licenseInventory = [];
  try {
    const packageJson = JSON.parse(await readFile(path.join(publicRoot, "package.json"), "utf8"));
    if (!packageJson.license) findings.push(finding("package-license-missing", "package.json"));
    const lock = JSON.parse(await readFile(path.join(publicRoot, "package-lock.json"), "utf8"));
    licenseInventory = collectLicenseInventory(lock);
  } catch {
    if (checkManifest || checkPack) findings.push(finding("license-inventory-unreadable"));
  }

  const deduplicated = [...new Map(
    findings.map((item) => [`${item.rule}:${item.path ?? ""}`, item]),
  ).values()].sort((a, b) => `${a.rule}:${a.path ?? ""}`.localeCompare(`${b.rule}:${b.path ?? ""}`));
  return {
    ok: deduplicated.length === 0,
    findings: deduplicated,
    fileCount: tree.files.length,
    packFiles,
    licenseInventory,
  };
}

function parseArgs(argv) {
  const args = { root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root" && argv[index + 1]) args.root = argv[++index];
    else if (argv[index] === "--denylist" && argv[index + 1]) args.denylistPath = argv[++index];
    else if (argv[index] === "--require-denylist") args.requireDenylist = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await auditPublicTree({
    root: args.root,
    denylistPath: args.denylistPath ?? process.env.MOODLE_CHANGEFEED_PUBLIC_DENYLIST_PATH,
    requireDenylist: args.requireDenylist,
  });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    findings: report.findings,
    fileCount: report.fileCount,
    packFileCount: report.packFiles.length,
    licenseCount: report.licenseInventory.length,
  })}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
