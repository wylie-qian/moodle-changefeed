import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeMoodleSnapshot,
  normalizeResourceLocator
} from "../src/core/normalize.mjs";

const SITE_KEY = "https://moodle.example.edu";

test("normalizes pluginfile resources on the configured HTTPS site", () => {
  const locator = normalizeResourceLocator(
    "https://moodle.example.edu/webservice/pluginfile.php/1/mod_resource/content/1/a.pdf?token=secret&forcedownload=1",
    { siteKey: SITE_KEY }
  );

  assert.deepEqual(locator, {
    pathname: "/webservice/pluginfile.php/1/mod_resource/content/1/a.pdf",
    forcedownload: true
  });
  assert.doesNotMatch(JSON.stringify(locator), /secret|token/);
});

test("resource locators reject unsafe origins, schemes, paths, and redirect parameters", () => {
  const invalid = [
    "http://moodle.example.edu/webservice/pluginfile.php/1/a.pdf",
    "https://user:pass@moodle.example.edu/webservice/pluginfile.php/1/a.pdf",
    "https://evil.example/webservice/pluginfile.php/1/a.pdf",
    "https://moodle.example.edu/mod/resource/view.php?id=1",
    "https://moodle.example.edu/webservice/pluginfile.php/1/../../login/index.php",
    "https://moodle.example.edu/webservice/pluginfile.php/1/a.pdf?redirect=https%3A%2F%2Fevil.example"
  ];

  for (const fileUrl of invalid) {
    assert.throws(
      () => normalizeResourceLocator(fileUrl, { siteKey: SITE_KEY }),
      /Moodle resource/i
    );
  }
});

test("normalization retains bounded study text locally without credential locators", () => {
  const input = {
    siteKey: SITE_KEY,
    capturedAt: "2026-08-01T00:00:00.000Z",
    courses: [{ id: 42, shortname: "EXAMPLE42", fullname: "Example course" }],
    coursePayloads: [
      {
        courseId: 42,
        assignments: [
          {
            id: 9001,
            name: "Example assignment",
            intro: "private assignment body",
            dueAt: "2026-08-01T20:00:00.000Z",
            introattachments: [
              {
                id: 777,
                filename: "brief.pdf",
                fileurl:
                  "https://moodle.example.edu/webservice/pluginfile.php/42/mod_assign/introattachment/0/brief.pdf?wstoken=private-token",
                filesize: 120,
                mimetype: "application/pdf"
              }
            ]
          }
        ],
        announcements: [
          { id: 8, title: "Welcome", body: "private announcement body" }
        ],
        contents: []
      }
    ],
    icsEvents: []
  };

  const first = normalizeMoodleSnapshot(input);
  const replay = normalizeMoodleSnapshot({
    ...input,
    courses: [...input.courses].reverse(),
    coursePayloads: [...input.coursePayloads].reverse()
  });

  assert.deepEqual(replay, first);
  assert.equal(first.objects.length, 3);
  assert.equal(first.resources.length, 1);
  assert.deepEqual(
    first.objects.find((item) => item.type === "assignment").prioritySignals,
    ["due_within_24h"]
  );
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(
    serialized,
    /private-token|wstoken/
  );
});

test("Moodle base paths are preserved in locators and site-scoped identifiers", () => {
  const locator = normalizeResourceLocator(
    "https://moodle.example.edu/learn/webservice/pluginfile.php/1/a.pdf",
    { siteKey: "https://moodle.example.edu/learn/" }
  );
  assert.equal(
    locator.pathname,
    "/learn/webservice/pluginfile.php/1/a.pdf"
  );

  const root = normalizeMoodleSnapshot({
    siteKey: SITE_KEY,
    courses: [],
    coursePayloads: [],
    icsEvents: [{ id: 1, courseId: 42, title: "Due" }]
  });
  const nested = normalizeMoodleSnapshot({
    siteKey: `${SITE_KEY}/learn`,
    courses: [],
    coursePayloads: [],
    icsEvents: [{ id: 1, courseId: 42, title: "Due" }]
  });
  assert.notEqual(root.objects[0].objectId, nested.objects[0].objectId);
});
