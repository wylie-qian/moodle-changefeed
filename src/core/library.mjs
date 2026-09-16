import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ChangefeedError } from "./errors.mjs";

export const moodleLibraryQuerySchema = z.object({
  courseId: z.string().min(1).max(200).optional(),
  query: z.string().max(500).optional(),
  type: z.enum(["assignment", "announcement", "resource"]).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50)
}).strict();

export const moodleLibraryItemSchema = z.object({
  objectId: z.string().min(1).max(2000)
}).strict();

export const moodleResourceReadSchema = z.object({
  resourceId: z.string().min(1).max(2000),
  includeText: z.boolean().default(false),
  maxTextBytes: z.number().int().min(1).max(262144).default(32768)
}).strict();

function resourceView(resource) {
  return {
    resourceId: resource.resourceId,
    fileName: resource.metadata?.fileName || "unnamed-file",
    mimeType: resource.metadata?.mimeType ?? null,
    size: resource.metadata?.size ?? null,
    cacheStatus: resource.cacheStatus,
    sha256: resource.contentSha256 ?? null,
    cachedBytes: resource.cachedBytes ?? null
  };
}

function sourceLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}

function itemView(object, resources) {
  return {
    objectId: object.objectId,
    type: object.type,
    course: {
      id: object.course?.id ?? null,
      code: object.course?.code ?? null,
      name: object.course?.name ?? null,
      term: object.course?.term ?? null
    },
    title: object.title,
    dueAt: object.dueAt ?? null,
    sourceUpdatedAt: object.sourceUpdatedAt ?? null,
    observation: object.observation ?? null,
    sourceLink: sourceLink(object.sourceLink),
    resources: resources.map(resourceView),
    contentAvailability: object.type === "resource" ? "file_resource" : "metadata_only"
  };
}

/** Current inventory is independent of the changefeed, including its first baseline. */
export class MoodleLibraryService {
  constructor({ store, resourceCache }) {
    if (!store || !resourceCache) throw new TypeError("store and resourceCache are required");
    this.store = store;
    this.resourceCache = resourceCache;
  }

  list(input = {}) {
    const { courseId, query, type, offset, limit } = moodleLibraryQuerySchema.parse(input);
    const needle = query?.trim().toLocaleLowerCase();
    const objects = (this.store.getLibraryObjects?.() ?? this.store.getCurrentObjects()).filter((object) =>
      (!courseId || String(object.course?.id) === courseId) &&
      (!type || object.type === type) &&
      (!needle || [object.title, object.course?.code, object.course?.name]
        .some((value) => String(value ?? "").toLocaleLowerCase().includes(needle)))
    ).sort((a, b) => a.objectId.localeCompare(b.objectId));
    const page = objects.slice(offset, offset + limit);
    const resources = new Map(this.store.getResources(
      [...new Set(page.flatMap((object) => object.resourceIds || []))]
    ).map((resource) => [resource.resourceId, resource]));
    return {
      items: page.map((object) => itemView(object, (object.resourceIds || [])
        .map((id) => resources.get(id)).filter(Boolean))),
      freshness: { ...this.store.getStatus(), scope: "global_pipeline_status; use each item observation for its last observed time" },
      total: objects.length,
      offset,
      nextOffset: offset + limit < objects.length ? offset + limit : null
    };
  }

  listCourses() {
    const courses = new Map();
    for (const object of (this.store.getLibraryObjects?.() ?? this.store.getCurrentObjects())) {
      const id = String(object.course?.id ?? "");
      if (!id) continue;
      if (!courses.has(id)) {
        courses.set(id, { id, code: object.course?.code ?? null,
          name: object.course?.name ?? null, term: object.course?.term ?? null,
          itemCount: 0 });
      }
      courses.get(id).itemCount += 1;
    }
    return {
      courses: [...courses.values()].sort((a, b) => a.id.localeCompare(b.id)),
      scope: "indexed_objects_only"
    };
  }

  getItem(input) {
    const { objectId } = moodleLibraryItemSchema.parse(input);
    const object = (this.store.getLibraryObjects?.() ?? this.store.getCurrentObjects()).find((item) => item.objectId === objectId);
    if (!object) throw new ChangefeedError("library_item_not_found", "Moodle library item not found");
    return {
      ...itemView(object, this.store.getResources(object.resourceIds || [])),
      ...(typeof object.contentText === "string" ? {
        contentText: object.contentText,
        contentTruncated: Boolean(object.contentTruncated),
        contentAvailability: "text",
        contentTrust: "untrusted_moodle_content"
      } : {})
    };
  }

  async readResource(input) {
    const { resourceId, includeText, maxTextBytes } = moodleResourceReadSchema.parse(input);
    const resource = this.store.getResources([resourceId])[0];
    if (!resource) throw new ChangefeedError("library_resource_not_found", "Moodle resource not found");
    const metadata = resourceView(resource);
    if (resource.cacheStatus !== "cached") {
      return { ...metadata, status: "not_cached", nextAction: "Cache this resourceId with cache_moodle_resources, then read it again." };
    }
    if (!/^[a-f0-9]{64}$/.test(resource.contentSha256 || "") ||
        !Number.isSafeInteger(resource.cachedBytes) || resource.cachedBytes < 0) {
      throw new ChangefeedError("cache_integrity_failed", "Moodle cache metadata is invalid; recache the resource");
    }
    let handle;
    try {
      const cachedPath = this.resourceCache.resolveCachedPath(resource);
      const root = await realpath(this.resourceCache.cacheRoot);
      const absolutePath = await realpath(cachedPath);
      const relative = path.relative(root, absolutePath);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new ChangefeedError("cache_integrity_failed", "Moodle cache path is outside its cache root");
      }
      handle = await open(absolutePath, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== resource.cachedBytes) {
        throw new ChangefeedError("cache_integrity_failed", "Moodle cache size does not match; recache the resource");
      }
      const hash = createHash("sha256");
      const chunks = [];
      let textBytes = 0;
      let bytes = 0;
      const isText = /^text\//i.test(metadata.mimeType || "") ||
        /^(application\/(json|xml|javascript)|application\/[a-z0-9.+-]+\+xml)$/i.test(metadata.mimeType || "");
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > stat.size) throw new ChangefeedError("cache_integrity_failed", "Moodle cache changed during verification");
        hash.update(chunk);
        if (includeText && isText && textBytes < maxTextBytes) {
          const prefix = chunk.subarray(0, maxTextBytes - textBytes);
          chunks.push(prefix);
          textBytes += prefix.length;
        }
      }
      if (bytes !== resource.cachedBytes || hash.digest("hex") !== resource.contentSha256) {
        throw new ChangefeedError("cache_integrity_failed", "Moodle cache hash does not match; recache the resource");
      }
      return {
        ...metadata, status: "verified", absolutePath, bytes,
        ...(includeText && isText ? {
          text: new TextDecoder("utf-8").decode(Buffer.concat(chunks), { stream: textBytes < bytes }),
          textTruncated: textBytes < bytes,
          textBytes
        } : {}),
        contentTrust: "untrusted_moodle_content",
        ...(includeText && !isText ? { textUnavailable: "Use absolutePath with a local PDF, document, or binary reader." } : {})
      };
    } catch (error) {
      if (error instanceof ChangefeedError) throw error;
      throw new ChangefeedError("cache_unavailable", "Moodle cached file is unavailable; recache the resource");
    } finally {
      await handle?.close();
    }
  }
}
