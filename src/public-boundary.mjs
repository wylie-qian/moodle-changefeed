import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".js", ".json", ".mjs"]);
const PRIVATE_IMPORT_PARTS = Object.freeze([
  "feishu-",
  "credential-store",
  "moodle-credentials",
  "moodle-pipeline-runtime",
  "state/private"
]);
const PRIVATE_MARKER_PARTS = Object.freeze([
  ["Key", "chain"].join(""),
  ["PersonalStudy", "Assistant"].join("")
]);
const IMPORT_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
const ABSOLUTE_USER_PATH_PATTERN = /\/Us[e]rs\//;

async function listSourceFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const childRelative = path.posix.join(relative, entry.name);
    const childPath = path.join(root, childRelative);
    const metadata = await lstat(childPath);
    if (metadata.isSymbolicLink()) {
      files.push({ path: childRelative, symlink: true });
    } else if (metadata.isDirectory()) {
      files.push(...(await listSourceFiles(root, childRelative)));
    } else if (
      metadata.isFile() &&
      SOURCE_EXTENSIONS.has(path.extname(entry.name))
    ) {
      files.push({ path: childRelative, symlink: false });
    }
  }
  return files;
}

export async function auditPublicImports({ packageRoot }) {
  if (!path.isAbsolute(packageRoot)) {
    throw new TypeError("packageRoot must be an absolute path");
  }
  const findings = [];
  for (const file of await listSourceFiles(packageRoot)) {
    if (file.symlink) {
      findings.push({ file: file.path, rule: "symlink" });
      continue;
    }
    const source = await readFile(path.join(packageRoot, file.path), "utf8");
    if (ABSOLUTE_USER_PATH_PATTERN.test(source)) {
      findings.push({ file: file.path, rule: "absolute-user-path" });
    }
    if (PRIVATE_MARKER_PARTS.some((part) => source.includes(part))) {
      findings.push({ file: file.path, rule: "private-marker" });
    }
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      if (PRIVATE_IMPORT_PARTS.some((part) => match[1].includes(part))) {
        findings.push({ file: file.path, rule: "private-import" });
      }
    }
  }
  return { findings };
}
