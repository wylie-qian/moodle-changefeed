import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  unlink
} from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Hex } from "../../core/contracts.mjs";
import { ChangefeedError } from "../../core/errors.mjs";

async function fileDigest(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function exists(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function sanitizeArchiveSegment(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/\0]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "_")
    .slice(0, 160);
  return normalized || "_";
}

function courseLabel(course = {}) {
  return [...new Set([course.code, course.name].filter(Boolean).map(String))].join(" - ") || "Unsorted course";
}

export class LocalArchiveAdapter {
  constructor({ rootDir, cache }) {
    if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
      throw new TypeError("rootDir must be an absolute path");
    }
    if (typeof cache?.resolveCachedPath !== "function") {
      throw new TypeError("cache.resolveCachedPath() is required");
    }
    this.id = "local_archive";
    this.rootDir = path.resolve(rootDir);
    this.cache = cache;
  }

  fingerprint() {
    return `local-archive:v1:${sha256Hex(this.rootDir).slice(0, 24)}`;
  }

  plan({ items, resources }) {
    const resourceMap = new Map(resources.map((resource) => [resource.resourceId, resource]));
    const operations = [];
    for (const item of items) {
      for (const resourceId of [...(item.resourceIds || [])].sort()) {
        const resource = resourceMap.get(resourceId);
        if (!resource) continue;
        const logicalArchiveSegments = [
          "Moodle",
          item.course?.term || "Unsorted term",
          courseLabel(item.course),
          item.type === "assignment" ? "Assignments" : "Resources",
          item.title,
          "Attachments"
        ].map(sanitizeArchiveSegment);
        const fileName = sanitizeArchiveSegment(resource.metadata?.fileName || "unnamed-file");
        const evidence = {
          itemId: item.id,
          resourceId,
          contentHash: resource.contentSha256,
          logicalArchiveSegments,
          fileName
        };
        operations.push({
          id: `moodle-delivery-op:v1:${sha256Hex(canonicalJson(evidence))}`,
          itemId: item.id,
          resourceId,
          expectedReviewVersion: item.version,
          expectedAfterHash: item.afterHash ?? null,
          contentHash: resource.contentSha256,
          logicalArchiveSegments,
          targetType: "archive_file",
          fileName,
          bytes: resource.cachedBytes,
          resource
        });
      }
    }
    return operations;
  }

  async execute(operation) {
    const segments = operation.logicalArchiveSegments.map(sanitizeArchiveSegment);
    const fileName = sanitizeArchiveSegment(operation.fileName);
    const parent = path.join(this.rootDir, ...segments);
    const targetPath = path.join(parent, fileName);
    if (await exists(targetPath)) {
      throw new ChangefeedError(
        "archive_target_conflict",
        "Local archive target already exists without a replay receipt"
      );
    }
    const sourcePath = this.cache.resolveCachedPath(operation.resource);
    const source = sourcePath ? await exists(sourcePath) : null;
    if (!source?.isFile() || source.isSymbolicLink()) {
      throw new ChangefeedError("archive_source_missing", "Verified cache source is unavailable");
    }
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const stagingPath = path.join(parent, `.${sha256Hex(operation.id).slice(0, 16)}-${randomUUID()}.part`);
    try {
      await copyFile(sourcePath, stagingPath, constants.COPYFILE_EXCL);
      await chmod(stagingPath, 0o600);
      const observed = await fileDigest(stagingPath);
      if (
        observed.sha256 !== operation.contentHash ||
        (Number.isSafeInteger(operation.bytes) && observed.bytes !== operation.bytes)
      ) {
        throw new ChangefeedError("archive_source_changed", "Cached resource verification failed");
      }
      const handle = await open(stagingPath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(stagingPath, targetPath);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new ChangefeedError(
            "archive_target_conflict",
            "Local archive target appeared during delivery"
          );
        }
        throw error;
      }
      await unlink(stagingPath);
      return {
        status: "delivered",
        contentHash: observed.sha256,
        bytes: observed.bytes,
        externalRef: `local-archive-ref:v1:${sha256Hex(canonicalJson({ segments, fileName })).slice(0, 24)}`
      };
    } catch (error) {
      try {
        await unlink(stagingPath);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw cleanupError;
      }
      throw error;
    }
  }
}
