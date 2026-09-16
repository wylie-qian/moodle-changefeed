import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseCli } from "../src/cli/parse.mjs";
import { runCli } from "../src/cli/main.mjs";
import {
  createEnvironmentCredentialProvider,
  loadPublicConfig
} from "../src/config.mjs";
import { restrictSnapshotToDomains } from "../src/runtime.mjs";

const AUTHORIZATION_REQUIRED = Object.freeze({
  schemaVersion: 1,
  status: "authorization_required",
  message: "已识别 Moodle，请完成学校登录授权",
  canScan: false,
  checkedAt: "2026-08-02T00:00:00.000Z"
});

const INVALID_SITE_URL = Object.freeze({
  schemaVersion: 1,
  status: "invalid_site_url",
  message: "Moodle 地址无效，请检查后重试",
  canScan: false,
  checkedAt: null
});

function jsonOutput() {
  const chunks = [];
  return {
    stream: {
      isTTY: false,
      write(chunk) {
        chunks.push(String(chunk));
      }
    },
    text() {
      return chunks.join("");
    }
  };
}

test("CLI rejects Moodle secrets in command-line arguments", () => {
  for (const args of [
    ["sync", "--token", "secret"],
    ["sync", "--moodle-token=secret"],
    ["sync", "--ics-url", "https://example.test/private"]
  ]) {
    assert.throws(
      () => parseCli(args),
      /token|ics.*environment|credential provider/i
    );
  }
});

test("CLI parser produces bounded commands without business logic", () => {
  assert.deepEqual(
    parseCli(["review", "decide", "change-1", "--expected-version", "2", "--approve"]),
    {
      command: "review.decide",
      input: {
        id: "change-1",
        expectedVersion: 2,
        decision: "approve"
      },
      configArgv: []
    }
  );
  assert.deepEqual(parseCli(["feed", "--limit", "25", "--type", "assignment"]), {
    command: "feed",
    input: { limit: 25, type: "assignment" },
    configArgv: []
  });
});

test("public config reports credential presence without exposing values", () => {
  const config = loadPublicConfig({
    argv: ["--site-url", "https://moodle.example.edu", "--data-dir", ".data"],
    env: {
      MOODLE_CHANGEFEED_TOKEN: "private-token",
      MOODLE_CHANGEFEED_ICS_URL: "https://moodle.example.edu/calendar/private"
    },
    cwd: "/tmp/changefeed-config"
  });

  assert.equal(config.siteUrl, "https://moodle.example.edu");
  assert.equal(config.dataDir, path.resolve("/tmp/changefeed-config", ".data"));
  assert.deepEqual(config.credentialStatus, {
    webServiceToken: "configured",
    icsUrl: "configured"
  });
  assert.equal(JSON.stringify(config).includes("private-token"), false);
  assert.equal(JSON.stringify(config).includes("calendar/private"), false);
});

test("environment credentials are bound to the canonical configured site", async () => {
  const provider = createEnvironmentCredentialProvider({
    MOODLE_CHANGEFEED_SITE_URL: "https://moodle.example.edu/learn/",
    MOODLE_CHANGEFEED_TOKEN: "private-token"
  });
  const unboundProvider = createEnvironmentCredentialProvider({
    MOODLE_CHANGEFEED_TOKEN: "private-token"
  });

  assert.equal(provider.siteKey, "https://moodle.example.edu/learn");
  assert.equal(await provider.getWebServiceToken(), "private-token");
  assert.equal(unboundProvider.siteKey, null);
  assert.doesNotMatch(JSON.stringify(provider), /private-token/);
});

test("bootstrap reports the closed Moodle entry connection and next action once", async () => {
  const output = jsonOutput();
  const result = await runCli({
    argv: ["bootstrap", "--site-url", "https://moodle.example.edu"],
    env: {
      MOODLE_CHANGEFEED_SITE_URL: "https://moodle.example.edu",
      MOODLE_CHANGEFEED_TOKEN: "fixture-secret"
    },
    output: output.stream,
    probeEntry: async () => AUTHORIZATION_REQUIRED,
    createRuntime() {
      throw new Error("bootstrap must not create the standalone runtime");
    }
  });

  assert.equal(result.connection.status, "authorization_required");
  assert.equal(result.next, "authorize");
  assert.equal(output.text().split("\n").filter(Boolean).length, 1);
  assert.deepEqual(JSON.parse(output.text()), result);
  assert.doesNotMatch(output.text(), /fixture-secret|functions|core_webservice_get_site_info/i);
});

test("bootstrap closes an invalid site URL instead of throwing before the probe", async () => {
  const output = jsonOutput();
  const result = await runCli({
    argv: ["bootstrap", "--site-url", "http://moodle.example.edu"],
    env: {},
    output: output.stream,
    probeEntry: async ({ siteUrl }) => {
      assert.equal(siteUrl, "http://moodle.example.edu");
      return INVALID_SITE_URL;
    },
    createRuntime() {
      throw new Error("invalid bootstrap must not create the standalone runtime");
    }
  });

  assert.equal(result.connection.status, "invalid_site_url");
  assert.equal(result.next, "configure_site");
  assert.equal(output.text(), `${JSON.stringify(result)}\n`);
});

test("bootstrap treats an invalid overridden environment site as unbound", async () => {
  const output = jsonOutput();
  let probeCalls = 0;
  const result = await runCli({
    argv: ["bootstrap", "--site-url", "https://moodle.example.edu"],
    env: {
      MOODLE_CHANGEFEED_SITE_URL: "not-a-valid-site",
      MOODLE_CHANGEFEED_TOKEN: "fixture-secret"
    },
    output: output.stream,
    probeEntry: async ({ siteUrl, credentialProvider }) => {
      probeCalls += 1;
      assert.equal(siteUrl, "https://moodle.example.edu");
      assert.equal(credentialProvider?.siteKey ?? null, null);
      assert.equal(await credentialProvider?.getWebServiceToken?.() ?? null, null);
      return AUTHORIZATION_REQUIRED;
    }
  });

  assert.equal(probeCalls, 1);
  assert.equal(result.connection.status, "authorization_required");
  assert.equal(result.next, "authorize");
  assert.doesNotMatch(output.text(), /fixture-secret|not-a-valid-site/);
});

test("bootstrap keeps credentials bound to a different valid environment site unbound", async () => {
  const output = jsonOutput();
  const result = await runCli({
    argv: ["bootstrap", "--site-url", "https://requested.example.edu"],
    env: {
      MOODLE_CHANGEFEED_SITE_URL: "https://configured.example.edu",
      MOODLE_CHANGEFEED_TOKEN: "fixture-secret"
    },
    output: output.stream,
    probeEntry: async ({ siteUrl, credentialProvider }) => {
      assert.equal(siteUrl, "https://requested.example.edu");
      assert.equal(credentialProvider?.siteKey ?? null, null);
      assert.equal(await credentialProvider?.getWebServiceToken?.() ?? null, null);
      return AUTHORIZATION_REQUIRED;
    }
  });

  assert.equal(result.connection.status, "authorization_required");
  assert.equal(result.next, "authorize");
  assert.doesNotMatch(output.text(), /fixture-secret|configured\.example\.edu/);
});

test("non-interactive delivery refuses to mint its own confirmation", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "changefeed-cli-confirm-"));
  const sink = { isTTY: false, write() {} };
  try {
    await assert.rejects(
      runCli({
        argv: [
          "delivery",
          "execute",
          "--plan-hash",
          "a".repeat(64),
          "--site-url",
          "https://moodle.example.edu",
          "--data-dir",
          dataDir
        ],
        env: { MOODLE_CHANGEFEED_WRITE_ENABLED: "true" },
        input: sink,
        output: sink
      }),
      (error) => error.code === "confirmation_provider_required"
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runtime honors enabled domains before normalization", () => {
  const restricted = restrictSnapshotToDomains(
    {
      coursePayloads: [{
        contents: [{ id: 1 }],
        assignments: [{ id: 2, introattachments: [{ id: 3 }] }],
        forums: [{ id: 4 }],
        announcements: [{ id: 5 }]
      }]
    },
    ["assignments"]
  );

  assert.deepEqual(restricted.coursePayloads[0], {
    contents: [],
    assignments: [{ id: 2, introattachments: [], attachments: [] }],
    forums: [],
    announcements: []
  });
});
