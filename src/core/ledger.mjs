import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

const REVIEW_STATUSES = [
  "pending",
  "approved",
  "ignored",
  "deferred",
  "ready_for_delivery",
  "delivered",
  "failed"
];
const SUPPORTED_SCHEMA_VERSION = 2;

const DECISION_STATUS = Object.freeze({
  approve: "approved",
  ignore: "ignored",
  defer: "deferred",
  resume: "pending"
});
const ALLOWED_REVIEW_DECISIONS = Object.freeze({
  pending: new Set(["approve", "ignore", "defer"]),
  deferred: new Set(["resume"])
});

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  return JSON.parse(value);
}

function requireNonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function revisionHashFor(object) {
  return requireNonEmpty(
    object.revisionHash || object.metadataHash || object.contentHash,
    "object revisionHash"
  );
}

function validateObject(object) {
  requireNonEmpty(object?.objectId, "objectId");
  requireNonEmpty(object?.type, "object type");
  requireNonEmpty(object?.course?.id, "object course.id");
  revisionHashFor(object);
}

function validateResource(resource) {
  requireNonEmpty(resource?.resourceId, "resourceId");
  requireNonEmpty(resource?.objectId, "resource objectId");
  requireNonEmpty(resource?.cacheStatus, "resource cacheStatus");
  requireNonEmpty(resource?.updatedAt, "resource updatedAt");
  if (!resource.metadata || typeof resource.metadata !== "object") {
    throw new TypeError("resource metadata must be an object");
  }
  if (!resource.locator || typeof resource.locator !== "object") {
    throw new TypeError("resource locator must be an object");
  }
}

function validateChange(change) {
  requireNonEmpty(change?.changeId, "changeId");
  requireNonEmpty(change?.objectId, "change objectId");
  requireNonEmpty(change?.changeKind, "changeKind");
  requireNonEmpty(change?.createdAt, "change createdAt");
  if (!change.payload || typeof change.payload !== "object") {
    throw new TypeError("change payload must be an object");
  }
}

function reviewRow(row) {
  if (!row) return null;
  const payload = parseJson(row.payload_json, {});
  return {
    sequence: row.sequence,
    id: row.change_id,
    version: row.version,
    reviewStatus: row.status,
    changeKind: row.change_kind,
    objectId: row.object_id,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    createdAt: row.created_at,
    ...payload,
    edited: parseJson(row.edited_json, null)
  };
}

function resourceRow(row) {
  if (!row) return null;
  return {
    resourceId: row.resource_id,
    objectId: row.object_id,
    metadata: parseJson(row.metadata_json, {}),
    locator: parseJson(row.locator_json, {}),
    contentSha256: row.content_sha256,
    cacheStatus: row.cache_status,
    cachedBytes: row.cached_bytes,
    updatedAt: row.updated_at
  };
}

export class MoodlePipelineStore {
  constructor({ dbPath, now = () => Date.now() }) {
    requireNonEmpty(dbPath, "dbPath");
    if (dbPath !== ":memory:" && !path.isAbsolute(dbPath)) {
      throw new TypeError("dbPath must be absolute");
    }
    this.now = now;
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbPath);
    try {
      if (dbPath !== ":memory:") chmodSync(dbPath, 0o600);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      this.#migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const current = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get().version;
    if (current > SUPPORTED_SCHEMA_VERSION) {
      throw new Error("Moodle 数据库版本更新，当前程序拒绝以旧 schema 打开");
    }
    if (current === SUPPORTED_SCHEMA_VERSION) return;

    const migrate = this.db.transaction(() => {
      if (current < 1) {
        this.db.exec(`
          CREATE TABLE scans (
            scan_id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            complete INTEGER NOT NULL DEFAULT 0,
            health_json TEXT NOT NULL DEFAULT '{}'
          );
          CREATE TABLE objects (
            object_id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            course_id TEXT NOT NULL,
            revision_hash TEXT NOT NULL,
            canonical_json TEXT NOT NULL,
            last_complete_scan_id TEXT
          );
          CREATE TABLE changes (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            change_id TEXT NOT NULL UNIQUE,
            object_id TEXT NOT NULL,
            change_kind TEXT NOT NULL,
            before_hash TEXT,
            after_hash TEXT,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE reviews (
            change_id TEXT PRIMARY KEY REFERENCES changes(change_id),
            status TEXT NOT NULL,
            version INTEGER NOT NULL,
            edited_json TEXT,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE resources (
            resource_id TEXT PRIMARY KEY,
            object_id TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            locator_json TEXT NOT NULL,
            content_sha256 TEXT,
            cache_status TEXT NOT NULL,
            cached_bytes INTEGER,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE confirmations (
            token_hash TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            target_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            consumed_at INTEGER
          );
          CREATE TABLE deliveries (
            delivery_key TEXT PRIMARY KEY,
            change_id TEXT NOT NULL,
            target_type TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            receipt_json TEXT,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE folders (
            logical_path TEXT PRIMARY KEY,
            external_ref TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX changes_object_id_idx ON changes(object_id);
          CREATE INDEX reviews_status_idx ON reviews(status);
          CREATE INDEX objects_course_id_idx ON objects(course_id);
        `);
        this.db
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)")
          .run(new Date(this.now()).toISOString());
      }
      if (current < 2) {
        this.db.exec(`
          CREATE TABLE observed_objects (
            object_id TEXT PRIMARY KEY,
            course_id TEXT NOT NULL,
            canonical_json TEXT NOT NULL,
            scan_id TEXT,
            observed_at TEXT,
            scan_complete INTEGER NOT NULL
          );
          CREATE INDEX observed_objects_course_id_idx ON observed_objects(course_id);
          INSERT INTO observed_objects(object_id, course_id, canonical_json, scan_id, observed_at, scan_complete)
          SELECT o.object_id, o.course_id, o.canonical_json, o.last_complete_scan_id,
                 s.completed_at, 1
          FROM objects o LEFT JOIN scans s ON s.scan_id = o.last_complete_scan_id;
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)")
          .run(new Date(this.now()).toISOString());
      }
    });
    migrate();
  }

  close() {
    if (this.db?.open) this.db.close();
  }

  beginScan({ scope, startedAt }) {
    requireNonEmpty(scope, "scope");
    requireNonEmpty(startedAt, "startedAt");
    const scanId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO scans(scan_id, scope, started_at, health_json) VALUES (?, ?, ?, '{}')"
      )
      .run(scanId, scope, startedAt);
    return scanId;
  }

  failScan({ scanId, health = {}, completedAt }) {
    requireNonEmpty(scanId, "scanId");
    requireNonEmpty(completedAt, "completedAt");
    const result = this.db
      .prepare(
        "UPDATE scans SET completed_at = ?, complete = 0, health_json = ? WHERE scan_id = ? AND completed_at IS NULL"
      )
      .run(completedAt, json(health), scanId);
    if (result.changes !== 1) throw new Error("Moodle scan 不存在或已经完成");
  }

  commitScan({
    scanId,
    complete,
    health = {},
    objects = [],
    resources = [],
    changes = [],
    completedAt
  }) {
    requireNonEmpty(scanId, "scanId");
    requireNonEmpty(completedAt, "completedAt");
    requireArray(objects, "objects").forEach(validateObject);
    requireArray(resources, "resources").forEach(validateResource);
    requireArray(changes, "changes").forEach(validateChange);
    if (!complete && changes.some((change) => change.changeKind === "possibly_missing")) {
      throw new Error("不完整扫描不能提交 possibly_missing 变化");
    }

    const transaction = this.db.transaction(() => {
      const scan = this.db
        .prepare("SELECT scope, completed_at FROM scans WHERE scan_id = ?")
        .get(scanId);
      if (!scan || scan.completed_at) throw new Error("Moodle scan 不存在或已经完成");

      if (complete) {
        if (scan.scope === "all") {
          this.db.prepare("DELETE FROM objects").run();
          this.db.prepare("DELETE FROM observed_objects").run();
        } else if (scan.scope.startsWith("course:")) {
          this.db
            .prepare("DELETE FROM objects WHERE course_id = ?")
            .run(scan.scope.slice("course:".length));
          this.db.prepare("DELETE FROM observed_objects WHERE course_id = ?")
            .run(scan.scope.slice("course:".length));
        } else if (scan.scope.startsWith("courses:")) {
          const courseIds = scan.scope
            .slice("courses:".length)
            .split(",")
            .filter(Boolean);
          if (courseIds.length > 0) {
            const placeholders = courseIds.map(() => "?").join(",");
            this.db
              .prepare(`DELETE FROM objects WHERE course_id IN (${placeholders})`)
              .run(...courseIds);
            this.db.prepare(`DELETE FROM observed_objects WHERE course_id IN (${placeholders})`)
              .run(...courseIds);
          }
        }
        const insertObject = this.db.prepare(`
          INSERT INTO objects(
            object_id, type, course_id, revision_hash, canonical_json,
            last_complete_scan_id
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(object_id) DO UPDATE SET
            type = excluded.type,
            course_id = excluded.course_id,
            revision_hash = excluded.revision_hash,
            canonical_json = excluded.canonical_json,
            last_complete_scan_id = excluded.last_complete_scan_id
        `);
        for (const object of objects) {
          insertObject.run(
            object.objectId,
            object.type,
            String(object.course.id),
            revisionHashFor(object),
            json(object),
            scanId
          );
        }
      }

      // Observations power browsing even when optional endpoints leave a scan partial.
      // Only complete scans remove inventory; the diff baseline above stays independent.
      const observeObject = this.db.prepare(`
        INSERT INTO observed_objects(object_id, course_id, canonical_json, scan_id, observed_at, scan_complete)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(object_id) DO UPDATE SET
          course_id = excluded.course_id,
          canonical_json = excluded.canonical_json,
          scan_id = excluded.scan_id,
          observed_at = excluded.observed_at,
          scan_complete = excluded.scan_complete
      `);
      for (const object of objects) {
        observeObject.run(object.objectId, String(object.course.id), json(object), scanId, completedAt, complete ? 1 : 0);
      }

      const upsertResource = this.db.prepare(`
        INSERT INTO resources(
          resource_id, object_id, metadata_json, locator_json,
          content_sha256, cache_status, cached_bytes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(resource_id) DO UPDATE SET
          object_id = excluded.object_id,
          metadata_json = excluded.metadata_json,
          locator_json = excluded.locator_json,
          content_sha256 = CASE
            WHEN json_extract(resources.metadata_json, '$.sourceContentHash')
              IS NOT json_extract(excluded.metadata_json, '$.sourceContentHash')
              OR json_extract(resources.metadata_json, '$.size')
                IS NOT json_extract(excluded.metadata_json, '$.size')
              OR json_extract(resources.metadata_json, '$.sourceUpdatedAt')
                IS NOT json_extract(excluded.metadata_json, '$.sourceUpdatedAt')
              THEN excluded.content_sha256
            ELSE COALESCE(excluded.content_sha256, resources.content_sha256)
          END,
          cache_status = CASE
            WHEN json_extract(resources.metadata_json, '$.sourceContentHash')
              IS NOT json_extract(excluded.metadata_json, '$.sourceContentHash')
              OR json_extract(resources.metadata_json, '$.size')
                IS NOT json_extract(excluded.metadata_json, '$.size')
              OR json_extract(resources.metadata_json, '$.sourceUpdatedAt')
                IS NOT json_extract(excluded.metadata_json, '$.sourceUpdatedAt')
              THEN excluded.cache_status
            WHEN excluded.content_sha256 IS NULL THEN resources.cache_status
            ELSE excluded.cache_status
          END,
          cached_bytes = CASE
            WHEN json_extract(resources.metadata_json, '$.sourceContentHash')
              IS NOT json_extract(excluded.metadata_json, '$.sourceContentHash')
              OR json_extract(resources.metadata_json, '$.size')
                IS NOT json_extract(excluded.metadata_json, '$.size')
              OR json_extract(resources.metadata_json, '$.sourceUpdatedAt')
                IS NOT json_extract(excluded.metadata_json, '$.sourceUpdatedAt')
              THEN excluded.cached_bytes
            ELSE COALESCE(excluded.cached_bytes, resources.cached_bytes)
          END,
          updated_at = excluded.updated_at
      `);
      for (const resource of resources) {
        upsertResource.run(
          resource.resourceId,
          resource.objectId,
          json(resource.metadata),
          json(resource.locator),
          resource.contentSha256 ?? null,
          resource.cacheStatus,
          resource.cachedBytes ?? null,
          resource.updatedAt
        );
      }

      const insertChange = this.db.prepare(`
        INSERT OR IGNORE INTO changes(
          change_id, object_id, change_kind, before_hash, after_hash,
          payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertReview = this.db.prepare(`
        INSERT OR IGNORE INTO reviews(
          change_id, status, version, edited_json, updated_at
        ) VALUES (?, 'pending', 1, NULL, ?)
      `);
      for (const change of changes) {
        if (change.changeKind === "unchanged") continue;
        const inserted = insertChange.run(
          change.changeId,
          change.objectId,
          change.changeKind,
          change.beforeHash ?? null,
          change.afterHash ?? null,
          json(change.payload),
          change.createdAt
        );
        if (inserted.changes === 1) {
          insertReview.run(change.changeId, change.createdAt);
        }
      }

      const updated = this.db
        .prepare(
          "UPDATE scans SET completed_at = ?, complete = ?, health_json = ? WHERE scan_id = ? AND completed_at IS NULL"
        )
        .run(completedAt, complete ? 1 : 0, json(health), scanId);
      if (updated.changes !== 1) throw new Error("Moodle scan 不存在或已经完成");
    });
    transaction();
  }

  getCurrentObjects() {
    return this.db
      .prepare("SELECT canonical_json FROM objects ORDER BY object_id")
      .all()
      .map((row) => parseJson(row.canonical_json));
  }

  getLibraryObjects() {
    return this.db.prepare("SELECT * FROM observed_objects ORDER BY object_id").all().map((row) => ({
      ...parseJson(row.canonical_json),
      observation: {
        scanId: row.scan_id,
        observedAt: row.observed_at,
        scanComplete: Boolean(row.scan_complete)
      }
    }));
  }

  getResources(resourceIds) {
    requireArray(resourceIds, "resourceIds");
    if (resourceIds.length === 0) return [];
    const uniqueIds = [...new Set(resourceIds.map(String))];
    const placeholders = uniqueIds.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM resources WHERE resource_id IN (${placeholders}) ORDER BY resource_id`
      )
      .all(...uniqueIds)
      .map(resourceRow);
  }

  recordCachedResource({ resourceId, sha256, bytes, cacheStatus, updatedAt }) {
    requireNonEmpty(resourceId, "resourceId");
    if (sha256 !== null) requireNonEmpty(sha256, "sha256");
    requireNonEmpty(cacheStatus, "cacheStatus");
    requireNonEmpty(updatedAt, "updatedAt");
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError("bytes must be a non-negative integer");
    }
    const result = this.db
      .prepare(`
        UPDATE resources
        SET content_sha256 = ?, cached_bytes = ?, cache_status = ?, updated_at = ?
        WHERE resource_id = ?
      `)
      .run(sha256, bytes, cacheStatus, updatedAt, resourceId);
    if (result.changes !== 1) throw new Error("Moodle 资源不存在");
    return this.getResources([resourceId])[0];
  }

  listReviewItems({
    afterSequence = 0,
    limit = 50,
    reviewStatus,
    courseId,
    type
  } = {}) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TypeError("afterSequence must be a non-negative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("limit must be between 1 and 100");
    }
    if (reviewStatus && !REVIEW_STATUSES.includes(reviewStatus)) {
      throw new TypeError("unknown reviewStatus");
    }
    const rows = this.db
      .prepare(`
        SELECT c.*, r.status, r.version, r.edited_json
        FROM changes c
        JOIN reviews r ON r.change_id = c.change_id
        WHERE c.sequence > ?
          AND (? IS NULL OR r.status = ?)
          AND (
            ? IS NULL OR
            CAST(json_extract(c.payload_json, '$.course.id') AS TEXT) = CAST(? AS TEXT)
          )
          AND (? IS NULL OR json_extract(c.payload_json, '$.type') = ?)
        ORDER BY c.sequence
        LIMIT ?
      `)
      .all(
        afterSequence,
        reviewStatus ?? null,
        reviewStatus ?? null,
        courseId ?? null,
        courseId ?? null,
        type ?? null,
        type ?? null,
        limit + 1
      )
      .map(reviewRow);
    const items = rows.slice(0, limit);
    return {
      items,
      nextSequence:
        rows.length > limit ? items[items.length - 1].sequence : null
    };
  }

  getReviewItem(id) {
    requireNonEmpty(id, "id");
    return reviewRow(
      this.db
        .prepare(`
          SELECT c.*, r.status, r.version, r.edited_json
          FROM changes c
          JOIN reviews r ON r.change_id = c.change_id
          WHERE c.change_id = ?
        `)
        .get(id)
    );
  }

  listReviewItemsForResource(resourceId) {
    requireNonEmpty(resourceId, "resourceId");
    return this.db
      .prepare(`
        SELECT c.*, r.status, r.version, r.edited_json
        FROM changes c
        JOIN reviews r ON r.change_id = c.change_id
        WHERE c.object_id = (
          SELECT object_id FROM resources WHERE resource_id = ?
        ) OR EXISTS (
          SELECT 1
          FROM json_each(c.payload_json, '$.resourceIds') resource
          WHERE CAST(resource.value AS TEXT) = CAST(? AS TEXT)
        )
        ORDER BY c.sequence
      `)
      .all(resourceId, resourceId)
      .map(reviewRow);
  }

  setReviewDecision({ id, expectedVersion, decision, updatedAt }) {
    return this.setReviewDecisions({
      actions: [{ id, expectedVersion, decision }],
      updatedAt
    })[0];
  }

  setReviewDecisions({ actions, updatedAt }) {
    requireNonEmpty(updatedAt, "updatedAt");
    requireArray(actions, "actions");
    const update = this.db.prepare(`
      UPDATE reviews
      SET status = ?, version = version + 1, updated_at = ?
      WHERE change_id = ? AND version = ? AND status = ?
    `);
    const transaction = this.db.transaction(() => {
      for (const { id, expectedVersion, decision } of actions) {
        requireNonEmpty(id, "id");
        const status = DECISION_STATUS[decision];
        if (!status) throw new TypeError("unknown review decision");
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
          throw new TypeError("expectedVersion must be positive");
        }
        const current = this.getReviewItem(id);
        if (!current) throw new Error("Moodle 审核项不存在");
        if (current.version !== expectedVersion) {
          throw new Error("Moodle 审核版本冲突");
        }
        if (!ALLOWED_REVIEW_DECISIONS[current.reviewStatus]?.has(decision)) {
          throw new Error(
            `Moodle 审核状态转换不允许：${current.reviewStatus} -> ${status}`
          );
        }
        const result = update.run(
          status,
          updatedAt,
          id,
          expectedVersion,
          current.reviewStatus
        );
        if (result.changes !== 1) {
          throw new Error("Moodle 审核版本冲突");
        }
      }
    });
    transaction();
    return actions.map(({ id }) => this.getReviewItem(id));
  }

  reviewCounts() {
    const counts = Object.fromEntries(REVIEW_STATUSES.map((status) => [status, 0]));
    for (const row of this.db
      .prepare("SELECT status, COUNT(*) AS count FROM reviews GROUP BY status")
      .all()) {
      if (Object.hasOwn(counts, row.status)) counts[row.status] = row.count;
    }
    return {
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      pending: counts.pending,
      approved: counts.approved,
      ignored: counts.ignored,
      deferred: counts.deferred,
      readyForDelivery: counts.ready_for_delivery,
      delivered: counts.delivered,
      failed: counts.failed
    };
  }

  getStatus() {
    const lastScan = this.db
      .prepare("SELECT * FROM scans ORDER BY rowid DESC LIMIT 1")
      .get();
    const lastComplete = this.db
      .prepare(
        "SELECT completed_at FROM scans WHERE complete = 1 ORDER BY rowid DESC LIMIT 1"
      )
      .get();
    return {
      schemaVersion: 1,
      lastScanAt: lastScan?.completed_at ?? null,
      lastScanComplete: Boolean(lastScan?.complete),
      lastScanHealth: parseJson(lastScan?.health_json, {}),
      lastCompleteScanAt: lastComplete?.completed_at ?? null,
      objectCount: this.db.prepare("SELECT COUNT(*) AS count FROM objects").get().count,
      resourceCount: this.db.prepare("SELECT COUNT(*) AS count FROM resources").get().count,
      counts: this.reviewCounts()
    };
  }

  prepareConfirmation({ action, targetHash, expiresAt }) {
    requireNonEmpty(action, "action");
    requireNonEmpty(targetHash, "targetHash");
    if (!Number.isSafeInteger(expiresAt)) {
      throw new TypeError("expiresAt must be epoch milliseconds");
    }
    const confirmationToken = randomBytes(32).toString("base64url");
    this.db
      .prepare(`
        INSERT INTO confirmations(
          token_hash, action, target_hash, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, NULL)
      `)
      .run(sha256(confirmationToken), action, targetHash, expiresAt);
    return { confirmationToken, action, targetHash, expiresAt };
  }

  consumeConfirmation({ token, action, targetHash, now }) {
    requireNonEmpty(token, "token");
    requireNonEmpty(action, "action");
    requireNonEmpty(targetHash, "targetHash");
    if (!Number.isSafeInteger(now)) throw new TypeError("now must be epoch milliseconds");
    const tokenHash = sha256(token);
    const consumed = this.db
      .prepare(`
        UPDATE confirmations
        SET consumed_at = ?
        WHERE token_hash = ? AND consumed_at IS NULL
      `)
      .run(now, tokenHash);
    if (consumed.changes !== 1) throw new Error("确认令牌无效或已使用");
    const record = this.db
      .prepare("SELECT * FROM confirmations WHERE token_hash = ?")
      .get(tokenHash);
    if (record.action !== action) throw new Error("确认操作不匹配");
    if (record.target_hash !== targetHash) throw new Error("确认目标不匹配");
    if (record.expires_at < now) throw new Error("确认令牌已过期");
    return { action, targetHash, consumedAt: now };
  }

  getDelivery(deliveryKey) {
    requireNonEmpty(deliveryKey, "deliveryKey");
    const row = this.db
      .prepare("SELECT * FROM deliveries WHERE delivery_key = ?")
      .get(deliveryKey);
    if (!row) return null;
    return {
      deliveryKey: row.delivery_key,
      changeId: row.change_id,
      targetType: row.target_type,
      contentHash: row.content_hash,
      status: row.status,
      receipt: parseJson(row.receipt_json, null),
      updatedAt: row.updated_at
    };
  }

  listDeliveriesForChange(changeId) {
    requireNonEmpty(changeId, "changeId");
    return this.db
      .prepare(
        "SELECT delivery_key FROM deliveries WHERE change_id = ? AND target_type != 'delivery_plan' ORDER BY delivery_key"
      )
      .all(changeId)
      .map(({ delivery_key: deliveryKey }) => this.getDelivery(deliveryKey));
  }

  recordDelivery(record) {
    requireNonEmpty(record?.deliveryKey, "deliveryKey");
    requireNonEmpty(record?.changeId, "changeId");
    requireNonEmpty(record?.targetType, "targetType");
    requireNonEmpty(record?.contentHash, "contentHash");
    requireNonEmpty(record?.status, "status");
    requireNonEmpty(record?.updatedAt, "updatedAt");
    this.db
      .prepare(`
        INSERT INTO deliveries(
          delivery_key, change_id, target_type, content_hash,
          status, receipt_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(delivery_key) DO UPDATE SET
          change_id = excluded.change_id,
          target_type = excluded.target_type,
          content_hash = excluded.content_hash,
          status = excluded.status,
          receipt_json = excluded.receipt_json,
          updated_at = excluded.updated_at
      `)
      .run(
        record.deliveryKey,
        record.changeId,
        record.targetType,
        record.contentHash,
        record.status,
        json(record.receipt),
        record.updatedAt
      );
    return this.getDelivery(record.deliveryKey);
  }

  getFolder(logicalPath) {
    requireNonEmpty(logicalPath, "logicalPath");
    const row = this.db
      .prepare("SELECT * FROM folders WHERE logical_path = ?")
      .get(logicalPath);
    if (!row) return null;
    return {
      logicalPath: row.logical_path,
      externalRef: row.external_ref,
      createdAt: row.created_at
    };
  }

  setFolder({ logicalPath, externalRef, createdAt }) {
    requireNonEmpty(logicalPath, "logicalPath");
    requireNonEmpty(externalRef, "externalRef");
    requireNonEmpty(createdAt, "createdAt");
    this.db
      .prepare(`
        INSERT INTO folders(logical_path, external_ref, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(logical_path) DO UPDATE SET
          external_ref = excluded.external_ref,
          created_at = excluded.created_at
      `)
      .run(logicalPath, externalRef, createdAt);
    return this.getFolder(logicalPath);
  }
}
