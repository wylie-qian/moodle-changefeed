import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createMoodleChangefeedMcpServer,
  startMoodleChangefeedStdio
} from "../src/mcp/server.mjs";

const TOOL_NAMES = [
  "list_moodle_courses",
  "search_moodle_library",
  "get_moodle_library_item",
  "read_moodle_resource",
  "agent_bootstrap",
  "cache_moodle_resources",
  "deliver_moodle_batch",
  "get_moodle_change_feed",
  "get_moodle_pipeline_status",
  "get_moodle_review_item",
  "list_moodle_changefeed_capabilities",
  "prepare_moodle_delivery",
  "scan_moodle_changes",
  "set_moodle_review_decision"
].sort();

const AUTHORIZATION_REQUIRED = Object.freeze({
  schemaVersion: 1,
  status: "authorization_required",
  message: "已识别 Moodle，请完成学校登录授权",
  canScan: false,
  checkedAt: "2026-08-02T00:00:00.000Z"
});

const COMPATIBLE = Object.freeze({
  schemaVersion: 1,
  status: "compatible",
  message: "Moodle 已连接，可开始同步",
  canScan: true,
  checkedAt: "2026-08-02T00:00:00.000Z"
});

function runtime() {
  return {
    config: { writeEnabled: false },
    service: {
      getStatus: async () => ({
        schemaVersion: 1,
        health: { status: "not_scanned", lastScanAt: null, lastCompleteScanAt: null },
        counts: { total: 0, pending: 0, approved: 0 },
        objectCount: 0,
        resourceCount: 0
      })
    },
    coordinator: {},
    close() {}
  };
}

test("standalone MCP exposes fourteen bounded tools", async () => {
  const server = createMoodleChangefeedMcpServer({
    createRuntime: async () => runtime(),
    probeEntry: async () => COMPATIBLE,
    publicConfig: {
      siteUrl: "https://moodle.example.edu",
      writeEnabled: false,
      credentialStatus: { webServiceToken: "configured", icsUrl: "missing" }
    }
  });
  const client = new Client({ name: "moodle-changefeed-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.listTools();
    assert.equal(result.tools.length, 14);
    assert.deepEqual(result.tools.map(({ name }) => name).sort(), TOOL_NAMES);
    const delivery = result.tools.find(({ name }) => name === "deliver_moodle_batch");
    assert.deepEqual(delivery.inputSchema.required.sort(), ["confirmationToken", "planHash"]);
    const bootstrapTool = result.tools.find(({ name }) => name === "agent_bootstrap");
    assert.deepEqual(Object.keys(bootstrapTool.inputSchema.properties), ["siteUrl"]);
    assert.equal(bootstrapTool.inputSchema.properties.siteUrl.type, "string");
    assert.equal(bootstrapTool.inputSchema.properties.siteUrl.minLength, 8);
    assert.equal(bootstrapTool.inputSchema.properties.siteUrl.maxLength, 2048);
    assert.equal(bootstrapTool.inputSchema.additionalProperties, false);
    assert.equal(bootstrapTool.annotations.openWorldHint, true);

    const bootstrap = await client.callTool({ name: "agent_bootstrap", arguments: {} });
    const bootstrapText = bootstrap.content.find(({ type }) => type === "text")?.text || "";
    assert.match(bootstrapText, /"schemaVersion":1/);
    assert.match(bootstrapText, /list_moodle_changefeed_capabilities/);
    assert.doesNotMatch(bootstrapText, /\/Users\/|private-token|webservice\/pluginfile/);

    const capabilities = await client.callTool({
      name: "list_moodle_changefeed_capabilities",
      arguments: { limit: 5 }
    });
    const capabilityText = capabilities.content.find(({ type }) => type === "text")?.text || "";
    assert.match(capabilityText, /confirmed_external_write/);
    assert.match(capabilityText, /"nextCursor":null/);
    assert.doesNotMatch(capabilityText, /\/Users\//);
  } finally {
    await client.close();
    await server.close();
  }
});

test("standalone bootstrap probes a foreign site anonymously without creating a runtime", async () => {
  const calls = [];
  const server = createMoodleChangefeedMcpServer({
    createRuntime() {
      throw new Error("foreign bootstrap must not create local runtime state");
    },
    publicConfig: {
      siteUrl: "https://configured.example.edu/learn",
      writeEnabled: false,
      credentialStatus: { webServiceToken: "configured", icsUrl: "missing" }
    },
    probeEntry: async (input) => {
      calls.push(structuredClone(input));
      return AUTHORIZATION_REQUIRED;
    }
  });
  const client = new Client({ name: "moodle-changefeed-foreign-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "agent_bootstrap",
      arguments: { siteUrl: "https://FOREIGN.example.edu/learn/" }
    });
    const value = JSON.parse(result.content.find(({ type }) => type === "text")?.text || "{}");

    assert.deepEqual(calls, [{
      siteUrl: "https://foreign.example.edu/learn",
      useConfiguredCredential: false
    }]);
    assert.deepEqual(value.connection, AUTHORIZATION_REQUIRED);
    assert.equal(value.routing.next, "authorize");
    assert.equal(Object.hasOwn(value.routing, "firstSync"), false);
    assert.doesNotMatch(JSON.stringify(value), /fixture-secret|\/Users\/|functions|core_webservice/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("standalone bootstrap creates local status only for its configured compatible site", async () => {
  const calls = [];
  const server = createMoodleChangefeedMcpServer({
    createRuntime: async () => {
      calls.push("runtime");
      return runtime();
    },
    publicConfig: {
      siteUrl: "https://moodle.example.edu/learn",
      writeEnabled: false,
      credentialStatus: { webServiceToken: "configured", icsUrl: "missing" }
    },
    probeEntry: async (input) => {
      calls.push(structuredClone(input));
      return COMPATIBLE;
    }
  });
  const client = new Client({ name: "moodle-changefeed-compatible-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "agent_bootstrap",
      arguments: { siteUrl: "https://MOODLE.example.edu/learn/" }
    });
    const value = JSON.parse(result.content.find(({ type }) => type === "text")?.text || "{}");

    assert.deepEqual(calls, [
      {
        siteUrl: "https://moodle.example.edu/learn",
        useConfiguredCredential: true
      },
      "runtime"
    ]);
    assert.deepEqual(value.connection, COMPATIBLE);
    assert.equal(value.routing.firstSync, "scan_moodle_changes");
    assert.equal(typeof value.routing.next, "string");
    assert.equal(Array.isArray(value.routing.next), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("configured closed bootstrap never creates the local runtime", async () => {
  const calls = [];
  const server = createMoodleChangefeedMcpServer({
    createRuntime() {
      throw new Error("closed bootstrap must not create local runtime state");
    },
    publicConfig: {
      siteUrl: "https://moodle.example.edu/learn",
      writeEnabled: false,
      credentialStatus: { webServiceToken: "configured", icsUrl: "missing" }
    },
    probeEntry: async (input) => {
      calls.push(structuredClone(input));
      return AUTHORIZATION_REQUIRED;
    }
  });
  const client = new Client({ name: "moodle-changefeed-closed-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "agent_bootstrap", arguments: {} });
    const value = JSON.parse(result.content.find(({ type }) => type === "text")?.text || "{}");

    assert.deepEqual(calls, [{
      siteUrl: "https://moodle.example.edu/learn",
      useConfiguredCredential: true
    }]);
    assert.deepEqual(value.connection, AUTHORIZATION_REQUIRED);
    assert.equal(value.routing.firstSync, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("production MCP startup preserves non-site configuration failures", async () => {
  await assert.rejects(
    startMoodleChangefeedStdio({
      env: { MOODLE_CHANGEFEED_DOMAINS: "grades" },
      transport: {}
    }),
    /domains must contain/i
  );
});

test("standalone stdio entry starts without private host configuration", async () => {
  const client = new Client({ name: "moodle-changefeed-stdio-test", version: "1.0.0" });
  const nodeExecutable = existsSync("/usr/local/bin/node")
    ? "/usr/local/bin/node"
    : process.execPath;
  const transport = new StdioClientTransport({
    command: nodeExecutable,
    args: ["src/mcp/server.mjs"],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {}
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.deepEqual(result.tools.map(({ name }) => name).sort(), TOOL_NAMES);
  } finally {
    await client.close();
  }
});

test("standalone stdio entry closes an invalid configured site without binding credentials", async () => {
  const client = new Client({ name: "moodle-changefeed-invalid-site-test", version: "1.0.0" });
  const nodeExecutable = existsSync("/usr/local/bin/node")
    ? "/usr/local/bin/node"
    : process.execPath;
  const transport = new StdioClientTransport({
    command: nodeExecutable,
    args: ["src/mcp/server.mjs"],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      MOODLE_CHANGEFEED_SITE_URL: "not-a-valid-site",
      MOODLE_CHANGEFEED_TOKEN: "fixture-secret"
    }
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "agent_bootstrap", arguments: {} });
    const value = JSON.parse(result.content.find(({ type }) => type === "text")?.text || "{}");

    assert.equal(value.connection.status, "invalid_site_url");
    assert.equal(value.connection.canScan, false);
    assert.equal(value.routing.next, "configure_site");
    assert.equal(value.configuration.siteUrl, "missing");
    assert.equal(value.configuration.webServiceToken, "missing");
    assert.doesNotMatch(JSON.stringify(value), /fixture-secret|not-a-valid-site/);
  } finally {
    await client.close();
  }
});
