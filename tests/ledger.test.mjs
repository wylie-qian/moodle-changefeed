import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MoodlePipelineStore } from "../src/core/ledger.mjs";

const NOW = "2026-08-01T00:00:00.000Z";
const OBJECT = {
  objectId: "moodle-object:v1:0123456789abcdef:42:assignment:7",
  type: "assignment",
  course: { id: "42", code: null, name: "Example", term: null },
  sourceId: "7",
  title: "Assignment",
  dueAt: null,
  sourceUpdatedAt: NOW,
  metadataHash: "a".repeat(64),
  contentHash: "b".repeat(64),
  sourceLink: null,
  prioritySignals: [],
  resourceIds: []
};
const CHANGE = {
  changeId: "moodle-change:v1:0123456789abcdef0123456789abcdef",
  objectId: OBJECT.objectId,
  changeKind: "added",
  beforeHash: null,
  afterHash: "c".repeat(64),
  payload: OBJECT,
  createdAt: NOW
};

async function withStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "changefeed-ledger-"));
  const store = new MoodlePipelineStore({
    dbPath: path.join(directory, "ledger.sqlite"),
    now: () => Date.parse(NOW)
  });
  try {
    return await run(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function addPendingReview(store) {
  const scanId = store.beginScan({ scope: "all", startedAt: NOW });
  store.commitScan({
    scanId,
    complete: true,
    health: { status: "healthy" },
    objects: [OBJECT],
    resources: [],
    changes: [CHANGE],
    completedAt: NOW
  });
}

test("ledger preserves optimistic review transitions", async () => {
  await withStore((store) => {
    addPendingReview(store);
    const approved = store.setReviewDecision({
      id: CHANGE.changeId,
      expectedVersion: 1,
      decision: "approve",
      updatedAt: NOW
    });
    assert.equal(approved.reviewStatus, "approved");
    assert.equal(approved.version, 2);
    assert.throws(
      () =>
        store.setReviewDecision({
          id: CHANGE.changeId,
          expectedVersion: 1,
          decision: "ignore",
          updatedAt: NOW
        }),
      /version|版本/i
    );
  });
});

test("confirmation tokens are target-bound and single-use", async () => {
  await withStore((store) => {
    const expiresAt = Date.parse(NOW) + 60_000;
    const prepared = store.prepareConfirmation({
      action: "delivery.execute",
      targetHash: "a".repeat(64),
      expiresAt
    });
    assert.deepEqual(
      store.consumeConfirmation({
        token: prepared.confirmationToken,
        action: "delivery.execute",
        targetHash: "a".repeat(64),
        now: Date.parse(NOW)
      }),
      {
        action: "delivery.execute",
        targetHash: "a".repeat(64),
        consumedAt: Date.parse(NOW)
      }
    );
    assert.throws(
      () =>
        store.consumeConfirmation({
          token: prepared.confirmationToken,
          action: "delivery.execute",
          targetHash: "a".repeat(64),
          now: Date.parse(NOW)
        }),
      /invalid|used|无效|使用/i
    );
  });
});

function commitObjects(store, { objects, complete = false, scope = "all", completedAt = NOW }) {
  const scanId = store.beginScan({ scope, startedAt: completedAt });
  store.commitScan({ scanId, objects, complete, completedAt });
  return scanId;
}

test("first partial scan makes observed objects browsable without creating a diff baseline", async () => {
  await withStore(store => {
    const scanId = commitObjects(store, { objects: [OBJECT] });
    assert.deepEqual(store.getCurrentObjects(), []);
    assert.deepEqual(store.getLibraryObjects(), [{ ...OBJECT, observation: { scanId, observedAt: NOW, scanComplete: false } }]);
    commitObjects(store, { objects: [] });
    assert.equal(store.getLibraryObjects().length, 1, "partial absence never removes an observation");
  });
});

test("partial observations update inventory while preserving the complete baseline", async () => {
  await withStore(store => {
    commitObjects(store, { objects: [OBJECT], complete: true });
    const updated = { ...OBJECT, title: "Updated assignment", metadataHash: "d".repeat(64) };
    const observedAt = "2026-08-02T00:00:00.000Z";
    const scanId = commitObjects(store, { objects: [updated], completedAt: observedAt });
    assert.deepEqual(store.getCurrentObjects(), [OBJECT]);
    assert.deepEqual(store.getLibraryObjects(), [{ ...updated, observation: { scanId, observedAt, scanComplete: false } }]);
  });
});

test("complete scopes replace only their observed inventory", async () => {
  await withStore(store => {
    const second = { ...OBJECT, objectId: "second", course: { ...OBJECT.course, id: "43" } };
    const third = { ...OBJECT, objectId: "third", course: { ...OBJECT.course, id: "44" } };
    commitObjects(store, { objects: [OBJECT, second, third] });
    commitObjects(store, { objects: [], complete: true, scope: "course:42" });
    assert.deepEqual(store.getLibraryObjects().map(object => object.objectId), ["second", "third"]);
    commitObjects(store, { objects: [], complete: true, scope: "courses:43,44" });
    assert.deepEqual(store.getLibraryObjects(), []);
    commitObjects(store, { objects: [OBJECT] });
    commitObjects(store, { objects: [], complete: true });
    assert.deepEqual(store.getLibraryObjects(), []);
  });
});

test("schema v1 upgrades its baseline into observed inventory without losing reviews", async () => {
  await withStore(store => {
    addPendingReview(store);
    const expected = store.getCurrentObjects();
    const scanId = store.db.prepare("SELECT last_complete_scan_id AS id FROM objects").get().id;
    store.db.exec("DROP TABLE observed_objects; DELETE FROM schema_migrations WHERE version = 2");
    const dbPath = store.dbPath;
    store.close();
    const upgraded = new MoodlePipelineStore({ dbPath });
    try {
      assert.equal(upgraded.getStatus().schemaVersion, 1);
      assert.equal(upgraded.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 2);
      assert.deepEqual(upgraded.getCurrentObjects(), expected);
      assert.deepEqual(upgraded.getLibraryObjects(), [{ ...OBJECT, observation: { scanId, observedAt: NOW, scanComplete: true } }]);
      assert.equal(upgraded.getReviewItem(CHANGE.changeId).reviewStatus, "pending");
    } finally { upgraded.close(); }
  });
});

test("failed commit rolls observed inventory back with the rest of the scan", async () => {
  await withStore(store => {
    commitObjects(store, { objects: [OBJECT], complete: true });
    const before = store.getLibraryObjects();
    store.db.exec("CREATE TRIGGER reject_resource BEFORE INSERT ON resources BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    const scanId = store.beginScan({ scope: "all", startedAt: NOW });
    assert.throws(() => store.commitScan({
      scanId, complete: true, objects: [], completedAt: NOW,
      resources: [{ resourceId: "r", objectId: OBJECT.objectId, cacheStatus: "pending", metadata: {}, locator: {}, updatedAt: NOW }]
    }), /synthetic failure/);
    assert.deepEqual(store.getLibraryObjects(), before);
    assert.deepEqual(store.getCurrentObjects(), [OBJECT]);
  });
});

test("resource cache invalidates when any source revision field changes, including null transitions", async () => {
  for (const [field, before, after] of [
    ["sourceContentHash", "old", "new"], ["sourceContentHash", null, "new"], ["sourceContentHash", "old", null],
    ["size", 10, 20], ["size", null, 10], ["size", 10, null],
    ["sourceUpdatedAt", NOW, "2026-08-02T00:00:00.000Z"], ["sourceUpdatedAt", null, NOW], ["sourceUpdatedAt", NOW, null]
  ]) {
    await withStore(store => {
      const metadata = { size: null, sourceContentHash: null, sourceUpdatedAt: null, [field]: before };
      const resource = { resourceId: "r", objectId: OBJECT.objectId, metadata, locator: { pathname: "/same-file.pdf" },
        contentSha256: "cached-hash", cacheStatus: "cached", cachedBytes: 10, updatedAt: NOW };
      const commit = resources => {
        const scanId = store.beginScan({ scope: "all", startedAt: NOW });
        store.commitScan({ scanId, complete: false, resources, completedAt: NOW });
      };
      commit([resource]);
      commit([{ ...resource, metadata: { ...metadata, [field]: after }, contentSha256: null, cachedBytes: null, cacheStatus: "not_cached" }]);
      const refreshed = store.getResources(["r"])[0];
      assert.equal(refreshed.contentSha256, null, `${field}: ${before} -> ${after}`);
      assert.equal(refreshed.cachedBytes, null);
      assert.equal(refreshed.cacheStatus, "not_cached");
    });
  }
});

test("unchanged resource metadata preserves existing cache, including absent versus null fields", async () => {
  await withStore(store => {
    const resource = { resourceId: "r", objectId: OBJECT.objectId, metadata: { size: 10 }, locator: {},
      contentSha256: "cached-hash", cacheStatus: "cached", cachedBytes: 10, updatedAt: NOW };
    const commit = resources => {
      const scanId = store.beginScan({ scope: "all", startedAt: NOW });
      store.commitScan({ scanId, complete: false, resources, completedAt: NOW });
    };
    commit([resource]);
    commit([{ ...resource, metadata: { size: 10, sourceUpdatedAt: null, sourceContentHash: null },
      contentSha256: null, cacheStatus: "not_cached", cachedBytes: null }]);
    const unchanged = store.getResources(["r"])[0];
    assert.equal(unchanged.contentSha256, "cached-hash");
    assert.equal(unchanged.cacheStatus, "cached");
    assert.equal(unchanged.cachedBytes, 10);
  });
});
