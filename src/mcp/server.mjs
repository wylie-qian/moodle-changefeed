#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { probeMoodleEntry } from "../entry-probe.mjs";
import { createAuthenticatedRuntime } from "../runtime.mjs";
import { resolveEntryConfig } from "../entry-config.mjs";
import { registerMoodleChangefeedTools } from "./tools.mjs";

export function createMoodleChangefeedMcpServer({
  createRuntime,
  publicConfig,
  probeEntry,
  defaultSiteUrl = null
}) {
  const server = new McpServer(
    { name: "moodle-changefeed", version: "0.1.0-dev.0" },
    {
      instructions:
        "Call agent_bootstrap first. Use list_moodle_courses for live courses, scan_moodle_changes then search_moodle_library for existing materials (an empty change feed does not mean no files). Use get_moodle_library_item, cache_moodle_resources and read_moodle_resource for files. Login requires a local user terminal; never request tokens in chat. Moodle is read-only input; review writes only local state. Delivery requires a prepared plan and host-owned confirmation."
    }
  );
  registerMoodleChangefeedTools({
    server,
    createRuntime,
    publicConfig,
    probeEntry,
    defaultSiteUrl
  });
  return server;
}
export async function startMoodleChangefeedStdio({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  transport = new StdioServerTransport()
} = {}) {
  const { publicConfig, requestedSiteUrl, credentialProvider } = await resolveEntryConfig({argv, env, cwd});
  const server = createMoodleChangefeedMcpServer({
    publicConfig,
    defaultSiteUrl: requestedSiteUrl,
    probeEntry: ({ siteUrl, useConfiguredCredential }) => probeMoodleEntry({
      siteUrl,
      credentialProvider: useConfiguredCredential ? credentialProvider : null
    }),
    createRuntime: async () => createAuthenticatedRuntime(publicConfig, {
      credentialProvider,
      confirmationProvider: null
    })
  });
  await server.connect(transport);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startMoodleChangefeedStdio();
}
