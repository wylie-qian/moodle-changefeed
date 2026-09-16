import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MoodleLibraryService } from "../src/core/library.mjs";
import { MoodlePipelineService } from "../src/core/service.mjs";
import { MoodlePipelineStore } from "../src/core/ledger.mjs";
import { normalizeMoodleSnapshot } from "../src/core/normalize.mjs";
import { diffMoodleObjects } from "../src/core/diff.mjs";
import { MoodleResourceCache } from "../src/cache/resource-cache.mjs";

async function withLibrary(run, mimeType = "text/plain") {
  const root = await mkdtemp(path.join(os.tmpdir(), "moodle-library-"));
  const store = new MoodlePipelineStore({ dbPath: path.join(root, "ledger.sqlite") });
  const body = "lecture notes contents";
  const cache = new MoodleResourceCache({
    store, dataDir: root, maxFileBytes: 1024, maxBatchBytes: 4096,
    client: { async fetchResource() { return new Response(body); } }
  });
  const snapshot = {
    siteKey: "https://moodle.example.edu", capturedAt: "2026-08-01T00:00:00.000Z",
    courses: [{ id: 42, shortname: "MATH42", fullname: "Example course" }],
    coursePayloads: [{
      courseId: 42,
      assignments: [{ id: 1, name: "Assignment 1", intro: "private text", duedate: 1785542400 }],
      announcements: [{ id: 2, title: "Welcome", body: "private announcement" }],
      contents: [{ modules: [{ url: "https://moodle.example.edu/mod/resource/view.php?id=5", contents: [{
        id: 99, filename: "lecture.txt", filesize: body.length, mimetype: mimeType,
        fileurl: "https://moodle.example.edu/webservice/pluginfile.php/42/lecture.txt?token=secret"
      }] }] }]
    }], icsEvents: [], complete: true,
    health: { status: "healthy", completeness: { resources: true, assignments: true, announcements: true } }
  };
  const service = new MoodlePipelineService({
    store, resourceCache: cache, sourceAdapter: { async collect() { return snapshot; } },
    normalizer: normalizeMoodleSnapshot, diffEngine: diffMoodleObjects,
    scanLockPath: path.join(root, "scan.lock")
  });
  try {
    const scan = await service.scan();
    await run({ library: new MoodleLibraryService({ store, resourceCache: cache }), service, scan, cache, store });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("first baseline exposes existing inventory despite empty changefeed", async () => {
  await withLibrary(async ({ library, service, scan }) => {
    assert.equal(scan.baselineCreated, true);
    assert.equal((await service.getFeed({ limit: 20 })).items.length, 0);
    const catalog = library.list();
    assert.equal(catalog.total, 3);
    const file = library.list({ type: "resource" }).items[0];
    assert.equal(file.resources[0].fileName, "lecture.txt");
    assert.deepEqual(library.getItem({ objectId: file.objectId }), file);
    assert.equal(library.list({ type: "announcement" }).items[0].contentAvailability, "metadata_only");
    assert.doesNotMatch(JSON.stringify(catalog), /secret|locator|pluginfile|private announcement/);
  });
});

test("catalog pagination and filters are independent of review state", async () => {
  await withLibrary(async ({ library }) => {
    const first = library.list({ limit: 2 });
    const second = library.list({ limit: 2, offset: first.nextOffset });
    assert.equal(first.items.length, 2);
    assert.equal(second.items.length, 1);
    assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.objectId)).size, 3);
    assert.equal(library.list({ courseId: "42", query: "LECTURE", type: "resource" }).total, 1);
    assert.equal(library.list({ courseId: "different" }).total, 0);
    assert.equal(library.list({ query: "math42" }).total, 3);
    assert.throws(() => library.list({ limit: 10000 }));
  });
});

test("resource reads verify bytes and return bounded text without locators", async () => {
  await withLibrary(async ({ library, cache }) => {
    const resourceId = library.list({ type: "resource" }).items[0].resources[0].resourceId;
    assert.equal((await library.readResource({ resourceId })).status, "not_cached");
    await cache.cache({ resourceIds: [resourceId] });
    const result = await library.readResource({ resourceId, includeText: true, maxTextBytes: 7 });
    assert.equal(result.status, "verified");
    assert.equal(result.text, "lecture");
    assert.equal(result.textTruncated, true);
    assert.equal(path.isAbsolute(result.absolutePath), true);
    assert.doesNotMatch(JSON.stringify(result), /secret|locator|pluginfile/);
    await writeFile(result.absolutePath, "x".repeat(result.bytes));
    await assert.rejects(library.readResource({ resourceId }), { code: "cache_integrity_failed" });
    await writeFile(result.absolutePath, "short");
    await assert.rejects(library.readResource({ resourceId }), { code: "cache_integrity_failed" });
  });
});

test("PDF is delivered by verified local path rather than interpreted as text", async () => {
  await withLibrary(async ({ library, cache }) => {
    const resourceId = library.list({ type: "resource" }).items[0].resources[0].resourceId;
    await cache.cache({ resourceIds: [resourceId] });
    const result = await library.readResource({ resourceId, includeText: true });
    assert.equal(result.status, "verified");
    assert.equal(result.text, undefined);
    assert.match(result.textUnavailable, /PDF/);
  }, "application/pdf");
});

test("details expose normalized text while catalog and course index remain concise", () => {
  const object = {
    objectId: "assignment-1", type: "assignment", title: "Problem set",
    course: { id: "42", code: "MATH42", name: "Mathematics" }, resourceIds: [],
    contentText: "Solve question one", contentTruncated: false,
    locator: { token: "do-not-return" }
  };
  const library = new MoodleLibraryService({
    store: { getCurrentObjects: () => [object],
    getStatus: () => ({lastScanComplete: true}), getResources: () => [] }, resourceCache: {}
  });
  const detail = library.getItem({ objectId: "assignment-1" });
  assert.equal(detail.contentText, "Solve question one");
  assert.equal(detail.contentAvailability, "text");
  assert.equal(detail.locator, undefined);
  assert.equal(library.list().items[0].contentText, undefined);
  assert.deepEqual(library.listCourses(), {
    courses: [{ id: "42", code: "MATH42", name: "Mathematics", term: null, itemCount: 1 }],
    scope: "indexed_objects_only"
  });
});
