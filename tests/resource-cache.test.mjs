import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, readFile, writeFile, unlink, symlink, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MoodleResourceCache } from "../src/cache/resource-cache.mjs";

const RESOURCE_ID = "moodle-resource:v1:0123456789abcdef:42:99";

class Store {
  constructor(mimeType) {
    this.resource = {
      resourceId: RESOURCE_ID,
      objectId: "moodle-object:v1:0123456789abcdef:42:resource:99",
      metadata: { fileName: "payload.bin", size: null, mimeType },
      locator: {
        pathname: "/webservice/pluginfile.php/42/mod_resource/content/1/payload.bin",
        forcedownload: false
      },
      contentSha256: null,
      cacheStatus: "not_cached",
      cachedBytes: null,
      updatedAt: "2026-08-01T00:00:00.000Z"
    };
  }
  getResources(ids) { return ids.includes(RESOURCE_ID) ? [structuredClone(this.resource)] : []; }
  recordCachedResource(record) {
    Object.assign(this.resource, {
      contentSha256: record.sha256,
      cachedBytes: record.bytes,
      cacheStatus: record.cacheStatus,
      updatedAt: record.updatedAt
    });
    return structuredClone(this.resource);
  }
}

test("cache accepts content by bytes rather than filename extension", async () => {
  for (const mimeType of [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/png",
    "text/plain",
    "application/zip",
    "application/octet-stream"
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "changefeed-cache-"));
    const bytes = new TextEncoder().encode(`bytes:${mimeType}`);
    const cache = new MoodleResourceCache({
      store: new Store(mimeType),
      client: {
        async fetchResource() {
          return new Response(bytes, {
            status: 200,
            headers: { "content-type": mimeType, "content-length": String(bytes.length) }
          });
        }
      },
      dataDir: root,
      maxFileBytes: 1024,
      maxBatchBytes: 4096
    });
    try {
      const result = await cache.cache({ resourceIds: [RESOURCE_ID] });
      assert.equal(result.items[0].status, "cached");
      assert.match(result.items[0].sha256, /^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a failed resource stream leaves no completed cache file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "changefeed-cache-"));
  const cache = new MoodleResourceCache({
    store: new Store("application/pdf"),
    client: { async fetchResource() { throw new Error("network failed"); } },
    dataDir: root,
    maxFileBytes: 1024,
    maxBatchBytes: 4096
  });
  try {
    const result = await cache.cache({ resourceIds: [RESOURCE_ID] });
    assert.equal(result.items[0].status, "quarantined");
    assert.deepEqual(await readdir(path.join(root, "staging")), []);
    assert.deepEqual(await readdir(path.join(root, "cache", "sha256")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withRepairCache(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "changefeed-cache-repair-"));
  const store = new Store("text/plain");
  let fetchCount = 0;
  const cache = new MoodleResourceCache({
    store, dataDir: root, maxFileBytes: 1024, maxBatchBytes: 4096,
    client: { async fetchResource() { fetchCount += 1; return new Response("original content"); } }
  });
  try { await run({ root, store, cache, fetchCount: () => fetchCount }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("already_cached verifies hash and size; corrupt bytes are preserved and repaired", async () => {
  await withRepairCache(async ({ cache, store, root, fetchCount }) => {
    const input = { resourceIds: [RESOURCE_ID] };
    await cache.cache(input);
    assert.equal((await cache.cache(input)).items[0].status, "already_cached");
    assert.equal(fetchCount(), 1);
    const target = cache.resolveCachedPath(store.resource);
    for (const corruption of ["x".repeat(16), "short"]) {
      await writeFile(target, corruption);
      const repaired = await cache.cache(input);
      assert.equal(repaired.items[0].status, "cached");
      assert.equal(await readFile(target, "utf8"), "original content");
      const quarantined = await readdir(path.join(root, "staging"));
      assert.ok(quarantined.some((name) => name.endsWith(".corrupt")));
      const preserved = await Promise.all(quarantined.map((name) => readFile(path.join(root, "staging", name), "utf8")));
      assert.ok(preserved.includes(corruption));
    }
    assert.equal(fetchCount(), 3);
  });
});

test("publication repairs a corrupt hash object even when resource was not marked cached", async () => {
  await withRepairCache(async ({ cache, store }) => {
    const input = { resourceIds: [RESOURCE_ID] };
    await cache.cache(input);
    const target = cache.resolveCachedPath(store.resource);
    await writeFile(target, "untrusted bytes");
    Object.assign(store.resource, { cacheStatus: "not_cached", contentSha256: null, cachedBytes: null });
    assert.equal((await cache.cache(input)).items[0].status, "cached");
    assert.equal(await readFile(target, "utf8"), "original content");
  });
});

test("symlink cache objects are rejected without changing their target", async () => {
  await withRepairCache(async ({ cache, store, root }) => {
    const input = { resourceIds: [RESOURCE_ID] };
    await cache.cache(input);
    const target = cache.resolveCachedPath(store.resource);
    const other = path.join(root, "unrelated-file");
    await writeFile(other, "must remain unchanged");
    await unlink(target);
    await symlink(other, target);
    const result = await cache.cache(input);
    assert.equal(result.items[0].status, "quarantined");
    assert.equal(result.items[0].reason, "unsafe_cache_path");
    assert.equal(await readFile(other, "utf8"), "must remain unchanged");
    assert.equal((await lstat(target)).isSymbolicLink(), true);
  });
});

test("concurrent same-content downloads publish one verified object", async () => {
  await withRepairCache(async ({ cache, store, root }) => {
    const input = { resourceIds: [RESOURCE_ID] };
    const results = await Promise.all([cache.cache(input), cache.cache(input)]);
    assert.ok(results.every((result) => ["cached", "already_cached"].includes(result.items[0].status)));
    assert.equal(await readFile(cache.resolveCachedPath(store.resource), "utf8"), "original content");
    assert.deepEqual(await readdir(path.join(root, "staging")), []);
  });
});
