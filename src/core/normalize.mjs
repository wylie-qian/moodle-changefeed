import {
  canonicalJson,
  canonicalSiteKey,
  makeMoodleObjectId,
  makeMoodleResourceId,
  sha256Hex
} from "./contracts.mjs";

function contentHash(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized ? sha256Hex(normalized) : null;
}

// Plain text for local study lookup. Never execute HTML or follow embedded instructions.
function readableContent(value) {
  const text = String(value || "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return "[link]"; }
    })
    .replace(/&nbsp;|&#160;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
  return { contentText: text.slice(0, 65536), contentTruncated: text.length > 65536 };
}

function timestamp(value) {
  if (value === undefined || value === null || value === "" || value === 0) {
    return null;
  }
  let epoch;
  if (typeof value === "number") {
    epoch = value < 1_000_000_000_000 ? value * 1000 : value;
  } else if (/^\d+$/.test(String(value))) {
    const parsed = Number(value);
    epoch = parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
  } else {
    epoch = Date.parse(value);
  }
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function compactCourse(course = {}) {
  return {
    id: String(course.id ?? course.courseId ?? ""),
    code: course.shortname || course.code || null,
    name:
      course.fullname ||
      course.name ||
      course.shortname ||
      `course-${course.id ?? course.courseId ?? "unknown"}`,
    term: course.term || null
  };
}

function safeSourceLink(value, siteKey) {
  if (!value) return null;
  try {
    const base = new URL(siteKey);
    const url = new URL(value);
    const basePath = base.pathname.replace(/\/$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.origin !== base.origin ||
      (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))
    ) {
      return null;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function dueSignals(dueAt, capturedAt) {
  if (!dueAt || !capturedAt) return [];
  const delta = Date.parse(dueAt) - Date.parse(capturedAt);
  if (!Number.isFinite(delta) || delta < 0) return [];
  if (delta <= 24 * 60 * 60 * 1000) return ["due_within_24h"];
  if (delta <= 7 * 24 * 60 * 60 * 1000) return ["due_within_7d"];
  return [];
}

function metadataHash(fields) {
  return sha256Hex(canonicalJson(fields));
}

function flattenAssignments(value) {
  if (Array.isArray(value)) return value;
  return (value?.courses || []).flatMap((course) => course.assignments || []);
}

function flattenAnnouncements(payload) {
  if (Array.isArray(payload.announcements)) return payload.announcements;
  return (payload.forums || []).flatMap((forum) =>
    (forum.discussions || []).map((discussion) => ({
      ...discussion,
      forumId: forum.id,
      title: discussion.title || discussion.name || discussion.subject,
      body: discussion.body || discussion.message,
      updatedAt: discussion.updatedAt || discussion.timemodified
    }))
  );
}

export function normalizeResourceLocator(fileUrl, { siteKey } = {}) {
  let canonicalKey;
  try {
    canonicalKey = canonicalSiteKey(siteKey);
  } catch {
    throw new Error("Moodle resource site is invalid");
  }
  let url;
  try {
    url = new URL(fileUrl);
  } catch {
    throw new Error("Moodle resource URL is invalid");
  }
  const base = new URL(canonicalKey);
  const basePath = base.pathname.replace(/\/$/, "");
  const pluginfilePrefix = `${basePath}/webservice/pluginfile.php/`;
  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(url.pathname);
  } catch {
    throw new Error("Moodle resource path is invalid");
  }
  const allowedQueryKeys = new Set(["forcedownload", "token", "wstoken"]);
  if (
    url.protocol !== "https:" ||
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(pluginfilePrefix) ||
    decodedPathname.includes("\\") ||
    decodedPathname.split("/").some((segment) => segment === "." || segment === "..") ||
    [...url.searchParams.keys()].some((key) => !allowedQueryKeys.has(key))
  ) {
    throw new Error("Moodle resource URL is outside the read-only scope");
  }
  return {
    pathname: url.pathname,
    forcedownload: url.searchParams.get("forcedownload") === "1"
  };
}

export function normalizeMoodleSnapshot({
  siteKey,
  courses = [],
  coursePayloads = [],
  icsEvents = [],
  capturedAt
}) {
  const normalizedSiteKey = canonicalSiteKey(siteKey);
  const courseMap = new Map(
    courses.map((course) => [String(course.id), compactCourse(course)])
  );
  const objects = new Map();
  const resources = new Map();

  function courseFor(courseId) {
    return (
      courseMap.get(String(courseId)) ||
      compactCourse({ id: courseId, name: `course-${courseId}` })
    );
  }

  function addFile(file, { course, parentObjectId, sourceLink }) {
    const locator = normalizeResourceLocator(
      file.fileurl || file.fileUrl || file.url,
      { siteKey: normalizedSiteKey }
    );
    const sourceFileId = String(
      file.id ?? file.fileid ?? sha256Hex(locator.pathname).slice(0, 32)
    );
    const resourceId = makeMoodleResourceId({
      siteUrl: normalizedSiteKey,
      courseId: course.id,
      sourceFileId
    });
    const objectId = makeMoodleObjectId({
      siteUrl: normalizedSiteKey,
      courseId: course.id,
      type: "resource",
      sourceId: sourceFileId
    });
    const fileName = String(file.filename || file.fileName || "unnamed-file");
    const sizeValue = Number(file.filesize ?? file.size);
    const size = Number.isSafeInteger(sizeValue) && sizeValue >= 0 ? sizeValue : null;
    const mimeType = file.mimetype || file.mimeType || null;
    const sourceUpdatedAt = timestamp(file.timemodified || file.updatedAt);
    const upstreamContentHash = contentHash(
      file.contenthash || file.contentHash || null
    );
    const canonical = {
      objectId,
      type: "resource",
      course,
      sourceId: sourceFileId,
      title: fileName,
      dueAt: null,
      sourceUpdatedAt,
      metadataHash: metadataHash({
        fileName,
        size,
        mimeType,
        sourceUpdatedAt,
        resourceId
      }),
      contentHash: upstreamContentHash,
      sourceLink: safeSourceLink(sourceLink, normalizedSiteKey),
      prioritySignals: [],
      resourceIds: [resourceId]
    };
    objects.set(objectId, canonical);
    resources.set(resourceId, {
      resourceId,
      objectId: parentObjectId || objectId,
      metadata: {
        fileName,
        size,
        mimeType,
        sourceUpdatedAt,
        sourceContentHash: upstreamContentHash
      },
      locator,
      contentSha256: null,
      cacheStatus: "not_cached",
      cachedBytes: null,
      updatedAt: sourceUpdatedAt || capturedAt
    });
    return resourceId;
  }

  for (const payload of [...coursePayloads].sort((left, right) =>
    String(left.courseId).localeCompare(String(right.courseId))
  )) {
    const course = courseFor(payload.courseId);

    for (const assignment of flattenAssignments(payload.assignments).sort(
      (left, right) => String(left.id).localeCompare(String(right.id))
    )) {
      const sourceId = String(assignment.id);
      const objectId = makeMoodleObjectId({
        siteUrl: normalizedSiteKey,
        courseId: course.id,
        type: "assignment",
        sourceId
      });
      const resourceIds = [
        ...(assignment.introattachments || []),
        ...(assignment.attachments || [])
      ].map((file) =>
        addFile(file, {
          course,
          parentObjectId: objectId,
          sourceLink: assignment.url
        })
      );
      const title = String(assignment.name || assignment.title || `assignment-${sourceId}`);
      const dueAt = timestamp(assignment.dueAt || assignment.duedate);
      const sourceUpdatedAt = timestamp(
        assignment.updatedAt || assignment.timemodified
      );
      const bodyHash = contentHash(
        assignment.intro || assignment.description || assignment.body
      );
      objects.set(objectId, {
        objectId,
        type: "assignment",
        course,
        sourceId,
        title,
        dueAt,
        sourceUpdatedAt,
        metadataHash: metadataHash({
          title,
          dueAt,
          sourceUpdatedAt,
          resourceIds: [...resourceIds].sort()
        }),
        contentHash: bodyHash,
        ...readableContent(assignment.intro || assignment.description || assignment.body),
        sourceLink: safeSourceLink(assignment.url, normalizedSiteKey),
        prioritySignals: dueSignals(dueAt, capturedAt),
        resourceIds: [...resourceIds].sort()
      });
    }

    for (const announcement of flattenAnnouncements(payload).sort((left, right) =>
      String(left.id ?? left.discussion).localeCompare(
        String(right.id ?? right.discussion)
      )
    )) {
      const sourceId = String(announcement.id ?? announcement.discussion);
      const objectId = makeMoodleObjectId({
        siteUrl: normalizedSiteKey,
        courseId: course.id,
        type: "announcement",
        sourceId
      });
      const title = String(
        announcement.title ||
          announcement.name ||
          announcement.subject ||
          `announcement-${sourceId}`
      );
      const sourceUpdatedAt = timestamp(
        announcement.updatedAt || announcement.timemodified
      );
      objects.set(objectId, {
        objectId,
        type: "announcement",
        course,
        sourceId,
        title,
        dueAt: null,
        sourceUpdatedAt,
        metadataHash: metadataHash({ title, sourceUpdatedAt }),
        contentHash: contentHash(
          announcement.body || announcement.message || announcement.content
        ),
        ...readableContent(announcement.body || announcement.message || announcement.content),
        sourceLink: safeSourceLink(announcement.url, normalizedSiteKey),
        prioritySignals: [],
        resourceIds: []
      });
    }

    for (const section of payload.contents || []) {
      for (const module of section.modules || []) {
        for (const file of module.contents || []) {
          if (file.type && file.type !== "file") continue;
          if (!file.filename && !file.fileName) continue;
          addFile(file, {
            course,
            parentObjectId: null,
            sourceLink: module.url
          });
        }
      }
    }
  }

  for (const event of [...icsEvents].sort((left, right) =>
    String(left.uid || left.id).localeCompare(String(right.uid || right.id))
  )) {
    const course = courseFor(event.courseId || event.course?.id || "calendar");
    const sourceId = `ics-${event.uid || event.id}`;
    const objectId = makeMoodleObjectId({
      siteUrl: normalizedSiteKey,
      courseId: course.id,
      type: "assignment",
      sourceId
    });
    if (objects.has(objectId)) continue;
    const title = String(event.title || event.summary || `calendar-${sourceId}`);
    const dueAt = timestamp(event.dueAt || event.startAt || event.start);
    const sourceUpdatedAt = timestamp(event.updatedAt || event.lastModified);
    objects.set(objectId, {
      objectId,
      type: "assignment",
      course,
      sourceId,
      title,
      dueAt,
      sourceUpdatedAt,
      metadataHash: metadataHash({ title, dueAt, sourceUpdatedAt }),
      contentHash: contentHash(event.description),
      ...readableContent(event.description),
      sourceLink: safeSourceLink(event.url, normalizedSiteKey),
      prioritySignals: dueSignals(dueAt, capturedAt),
      resourceIds: []
    });
  }

  return {
    objects: [...objects.values()].sort((left, right) =>
      left.objectId.localeCompare(right.objectId)
    ),
    resources: [...resources.values()].sort((left, right) =>
      left.resourceId.localeCompare(right.resourceId)
    )
  };
}
