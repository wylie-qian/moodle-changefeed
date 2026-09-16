import { MoodleWebServiceError } from "./client.mjs";

function errorCode(error) {
  if (error?.code === "capability_unavailable") {
    return "capability_unavailable";
  }
  return error instanceof MoodleWebServiceError
    ? error.errorCode || "request_failed"
    : error?.errorCode || "request_failed";
}

const TRANSIENT_ERROR_CODES = new Set([
  "request_failed",
  "dbconnectionfailed"
]);
const DISCUSSION_PAGE_SIZE = 100;
const MAX_DISCUSSION_PAGES = 20;

async function readWithTransientRetry(operation, retryDelayMs) {
  try {
    return await operation();
  } catch (error) {
    if (!TRANSIENT_ERROR_CODES.has(errorCode(error))) throw error;
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    return operation();
  }
}

function courseAssignments(payload, courseId) {
  const course = (payload?.courses || []).find(
    (item) => String(item.id) === String(courseId)
  );
  return course?.assignments || [];
}

async function collectCourse(client, course, { retryDelayMs }) {
  const failures = [];
  let contents = [];
  let assignments = [];
  let forums = [];

  try {
    contents = await readWithTransientRetry(
      () => client.getCourseContents(course.id),
      retryDelayMs
    );
  } catch (error) {
    failures.push({ domain: "resources", errorCode: errorCode(error) });
  }

  try {
    assignments = await readWithTransientRetry(
      async () =>
        courseAssignments(
          await client.call("mod_assign_get_assignments", {
            courseids: [course.id]
          }),
          course.id
        ),
      retryDelayMs
    );
  } catch (error) {
    failures.push({ domain: "assignments", errorCode: errorCode(error) });
  }

  try {
    forums = await readWithTransientRetry(async () => {
      const collectedForums = [];
      const availableForums = await client.call(
        "mod_forum_get_forums_by_courses",
        { courseids: [course.id] }
      );
      const announcementForums = (availableForums || []).filter(
        (forum) => forum.type === "news"
      );
      for (const forum of announcementForums.sort((left, right) =>
        String(left.id).localeCompare(String(right.id))
      )) {
        const discussions = [];
        for (let page = 0; page <= MAX_DISCUSSION_PAGES; page += 1) {
          const result = await client.call("mod_forum_get_forum_discussions", {
            forumid: forum.id,
            page,
            perpage: DISCUSSION_PAGE_SIZE
          });
          const pageDiscussions = result?.discussions || [];
          if (page === MAX_DISCUSSION_PAGES && pageDiscussions.length > 0) {
            throw new MoodleWebServiceError(
              "Moodle 公告分页超过安全读取上限。",
              {
                errorCode: "pagination_limit",
                functionName: "mod_forum_get_forum_discussions"
              }
            );
          }
          discussions.push(...pageDiscussions);
          if (pageDiscussions.length < DISCUSSION_PAGE_SIZE) break;
        }
        collectedForums.push({
          ...forum,
          discussions
        });
      }
      return collectedForums;
    }, retryDelayMs);
  } catch (error) {
    failures.push({ domain: "announcements", errorCode: errorCode(error) });
  }

  return {
    payload: {
      courseId: course.id,
      contents,
      assignments,
      forums
    },
    failures
  };
}

async function boundedMap(values, concurrency, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function run() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => run())
  );
  return results;
}

export async function collectMoodleRawSnapshot({
  client,
  icsEvents = [],
  courseIds,
  courseConcurrency = 2,
  retryDelayMs = 250,
  capturedAt
}) {
  if (!client) throw new TypeError("Moodle client is required");
  if (!Array.isArray(icsEvents)) throw new TypeError("icsEvents must be an array");
  if (
    courseIds !== undefined &&
    (!Array.isArray(courseIds) ||
      courseIds.length < 1 ||
      courseIds.length > 100 ||
      courseIds.some(
        (value) =>
          !(
            (typeof value === "string" && value.length >= 1 && value.length <= 80) ||
            (Number.isSafeInteger(value) && value > 0)
          )
      ))
  ) {
    throw new TypeError("courseIds must contain 1–100 valid ids when provided");
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError("retryDelayMs must be a non-negative integer");
  }
  const site = await client.getSiteInfo();
  const allCourses = await client.getUserCourses(site.userid);
  const selectedIds = courseIds
    ? new Set(courseIds.map((value) => String(value)))
    : null;
  const courses = allCourses
    .filter((course) => !selectedIds || selectedIds.has(String(course.id)))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const returnedIds = new Set(courses.map(({ id }) => String(id)));
  const missingCourseIds = selectedIds
    ? [...selectedIds].filter((id) => !returnedIds.has(id)).sort()
    : [];
  const concurrency = Math.max(
    1,
    Math.min(Number.isSafeInteger(courseConcurrency) ? courseConcurrency : 2, 4)
  );
  const collected = await boundedMap(courses, concurrency, (course) =>
    collectCourse(client, course, { retryDelayMs })
  );

  const completeness = {
    resources: missingCourseIds.length === 0,
    assignments: missingCourseIds.length === 0,
    announcements: missingCourseIds.length === 0
  };
  const failedCourseIds = new Set(missingCourseIds);
  const errors = missingCourseIds.map((courseId) => ({
    courseId,
    errorCode: "course_not_found"
  }));
  for (let index = 0; index < collected.length; index += 1) {
    for (const failure of collected[index].failures) {
      completeness[failure.domain] = false;
      const courseId = String(courses[index].id);
      failedCourseIds.add(courseId);
      errors.push({ courseId, errorCode: failure.errorCode });
    }
  }
  errors.sort(
    (left, right) =>
      left.courseId.localeCompare(right.courseId) ||
      left.errorCode.localeCompare(right.errorCode)
  );
  const complete = Object.values(completeness).every(Boolean);

  return {
    siteKey: client.siteKey || client.siteUrl,
    capturedAt,
    courses,
    coursePayloads: collected.map(({ payload }) => payload),
    icsEvents: [...icsEvents],
    complete,
    health: {
      status: complete ? "healthy" : "degraded",
      completeness,
      failedCourseIds: [...failedCourseIds].sort(),
      errors
    }
  };
}

export class MoodleMobileSourceAdapter {
  constructor({
    client,
    icsAdapter = null,
    courseConcurrency = 2,
    retryDelayMs = 250
  }) {
    if (!client) throw new TypeError("Moodle client is required");
    this.client = client;
    this.icsAdapter = icsAdapter;
    this.courseConcurrency = courseConcurrency;
    this.retryDelayMs = retryDelayMs;
  }

  async collect({ courseIds, capturedAt } = {}) {
    let icsEvents = [];
    let icsFailed = false;
    try { icsEvents = this.icsAdapter ? await this.icsAdapter.collect() : []; }
    catch { icsFailed = true; }
    const snapshot = await collectMoodleRawSnapshot({
      client: this.client,
      icsEvents,
      courseIds: courseIds?.length ? courseIds : undefined,
      courseConcurrency: this.courseConcurrency,
      retryDelayMs: this.retryDelayMs,
      capturedAt
    });
    if (icsFailed) {
      snapshot.complete = false;
      snapshot.health.status = "degraded";
      snapshot.health.completeness.calendar = false;
      snapshot.health.errors.push({ domain: "calendar", errorCode: "ics_unavailable" });
    }
    return snapshot;
  }
}
