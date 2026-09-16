#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { LocalArchiveAdapter } from "../adapters/local-archive/index.mjs";
import { MoodleResourceCache } from "../cache/resource-cache.mjs";
import {
  loadPublicConfig
} from "../config.mjs";
import {
  MemoryConfirmationProvider,
  MoodleDeliveryCoordinator
} from "../core/delivery-coordinator.mjs";
import { diffMoodleObjects } from "../core/diff.mjs";
import { MoodlePipelineStore } from "../core/ledger.mjs";
import { normalizeMoodleSnapshot } from "../core/normalize.mjs";
import { MoodlePipelineService } from "../core/service.mjs";
import { probeMoodleEntry } from "../entry-probe.mjs";
import {
  invokeRuntimeCommand
} from "../runtime.mjs";
import { resolveEntryConfig } from "../entry-config.mjs";
import { login } from "./login.mjs";
import { createAuthenticatedRuntime } from "../runtime.mjs";
import { CLI_HELP, parseCli } from "./parse.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO_NOW = Date.parse("2026-08-01T00:10:00.000Z");
const NEXT_BY_STATUS = Object.freeze({
  site_url_required: "configure_site",
  authorization_required: "authorize",
  compatible: "sync",
  compatible_no_courses: "sync",
  invalid_site_url: "configure_site",
  unsupported_site: "choose_another_site",
  temporarily_unreachable: "retry_later"
});

class SyntheticDemoConfirmationProvider extends MemoryConfirmationProvider {}

function safeFixtureRoot(fixture) {
  if (!/^anonymous\/[a-z0-9][a-z0-9_-]{0,63}$/.test(fixture || "")) {
    throw new TypeError("Only bundled anonymous fixtures are accepted");
  }
  const root = path.resolve(PACKAGE_ROOT, "fixtures", fixture);
  const anonymousRoot = path.resolve(PACKAGE_ROOT, "fixtures", "anonymous");
  if (!root.startsWith(`${anonymousRoot}${path.sep}`)) {
    throw new TypeError("Fixture path is outside the anonymous fixture directory");
  }
  return root;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function runDemo({ fixture = "anonymous/basic", tempDir } = {}) {
  const fixtureRoot = safeFixtureRoot(fixture);
  const ownsTempDir = !tempDir;
  const root = tempDir || await mkdtemp(path.join(os.tmpdir(), "moodle-changefeed-demo-"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const store = new MoodlePipelineStore({
    dbPath: path.join(root, "ledger.sqlite"),
    now: () => DEMO_NOW
  });
  try {
    const snapshots = await Promise.all([
      readJson(path.join(fixtureRoot, "baseline.json")),
      readJson(path.join(fixtureRoot, "changed.json"))
    ]);
    const fixtureBytes = await readFile(
      path.join(fixtureRoot, "files", "assignment-brief.txt")
    );
    let snapshotIndex = 0;
    const sourceAdapter = {
      async collect() {
        return structuredClone(snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]);
      }
    };
    const resourceClient = {
      async fetchResource() {
        return new Response(fixtureBytes, {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-length": String(fixtureBytes.length)
          }
        });
      }
    };
    const cache = new MoodleResourceCache({
      store,
      client: resourceClient,
      dataDir: root,
      maxFileBytes: 1024 * 1024,
      maxBatchBytes: 2 * 1024 * 1024,
      now: () => DEMO_NOW
    });
    const service = new MoodlePipelineService({
      store,
      sourceAdapter,
      normalizer: normalizeMoodleSnapshot,
      diffEngine: diffMoodleObjects,
      resourceCache: cache,
      scanLockPath: path.join(root, "scan.lock"),
      clock: () => DEMO_NOW
    });
    const confirmationProvider = new SyntheticDemoConfirmationProvider({
      clock: () => DEMO_NOW
    });
    const coordinator = new MoodleDeliveryCoordinator({
      store,
      adapters: [
        new LocalArchiveAdapter({
          rootDir: path.join(root, "archive"),
          cache
        })
      ],
      confirmationProvider,
      clock: () => DEMO_NOW,
      writeEnabled: true
    });

    await service.scan();
    const baselineFeed = await service.getFeed({ limit: 100 });
    await service.scan();
    const changedFeed = await service.getFeed({ limit: 100 });
    const selected = changedFeed.items.find(
      (item) => item.type === "assignment" && item.resourceRefs.length > 0
    );
    if (!selected) throw new Error("Anonymous fixture did not create a deliverable assignment");
    await service.cacheResources({ reviewItemIds: [selected.id] });
    const review = await service.setReviewDecision({
      actions: [
        {
          id: selected.id,
          expectedVersion: selected.version,
          decision: "approve"
        }
      ]
    });
    const plan = await coordinator.prepare({
      reviewItemIds: [selected.id],
      targets: ["local_archive"]
    });
    const confirmationToken = confirmationProvider.issue({
      binding: coordinator.getConfirmationBinding(plan.planHash),
      expiresAt: DEMO_NOW + 60_000
    });
    const delivery = await coordinator.deliver({ planHash: plan.planHash, confirmationToken });
    return {
      baselineReviewCount: baselineFeed.items.length,
      changedReviewCount: changedFeed.items.length,
      approvedCount: review.items.filter((item) => item.reviewStatus === "approved").length,
      deliveredCount: delivery.succeeded,
      duplicateCount: delivery.replayed
    };
  } finally {
    store.close();
    if (ownsTempDir) await rm(root, { recursive: true, force: true });
  }
}

async function confirmPlanHash({ planHash, input, output }) {
  const prompt = createInterface({ input, output, terminal: true });
  try {
    const answer = await prompt.question(`Type the exact delivery plan hash to confirm:\n${planHash}\n> `);
    if (answer.trim() !== planHash) throw new Error("Delivery confirmation did not match plan hash");
  } finally {
    prompt.close();
  }
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function bootstrapResult({ config, connection, env, siteUrl }) {
  return {
    schemaVersion: 1,
    package: "moodle-changefeed",
    siteConfigured: Boolean(config?.siteUrl || siteUrl),
    credentialStatus: config?.credentialStatus || {
      webServiceToken: env.MOODLE_CHANGEFEED_TOKEN ? "configured" : "missing",
      icsUrl: env.MOODLE_CHANGEFEED_ICS_URL ? "configured" : "missing"
    },
    writeEnabled: config?.writeEnabled ?? (env.MOODLE_CHANGEFEED_WRITE_ENABLED === "true"),
    connection,
    next: NEXT_BY_STATUS[connection.status]
  };
}

function isInvalidSiteConfigError(error) {
  return error instanceof TypeError && /^Moodle site\b/.test(String(error.message));
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  input = process.stdin,
  output = process.stdout,
  confirmationProvider = null,
  fetchImpl = globalThis.fetch,
  probeEntry = probeMoodleEntry,
  createRuntime = createAuthenticatedRuntime
} = {}) {
  const parsed = parseCli(argv);
  if (parsed.command === "help") {
    output.write(`${CLI_HELP}\n`);
    return { ok: true, command: "help" };
  }
  if (parsed.command === "demo") {
    const result = await runDemo({ fixture: parsed.input.fixture || "anonymous/basic" });
    writeJson(output, result);
    return result;
  }
  if (parsed.command === "login") {
    const result = await login({config: loadPublicConfig({argv: parsed.configArgv, env, cwd}), method: parsed.input.method,
      env, input, output, fetchImpl});
    writeJson(output, result);
    return result;
  }
  const requestedSiteUrl = parsed.siteUrl ?? env.MOODLE_CHANGEFEED_SITE_URL ?? null;
  let config;
  let credentialProvider;
  try {
    const resolved = await resolveEntryConfig({argv: parsed.configArgv, env, cwd});
    config = resolved.publicConfig;
    credentialProvider = resolved.credentialProvider;
    if (requestedSiteUrl && !config.siteUrl) throw new TypeError("Moodle site URL is invalid");
  } catch (error) {
    if (!["bootstrap", "sync"].includes(parsed.command) || !isInvalidSiteConfigError(error)) {
      throw error;
    }
    const connection = await probeEntry({
      siteUrl: requestedSiteUrl,
      credentialProvider: null,
      fetchImpl
    });
    const result = parsed.command === "bootstrap"
      ? bootstrapResult({ config: null, connection, env, siteUrl: requestedSiteUrl })
      : { schemaVersion: 1, connection };
    writeJson(output, result);
    return result;
  }
  if (parsed.command === "bootstrap") {
    const connection = await probeEntry({
      siteUrl: config.siteUrl,
      credentialProvider,
      fetchImpl
    });
    const result = bootstrapResult({ config, connection, env, siteUrl: requestedSiteUrl });
    writeJson(output, result);
    return result;
  }
  if (parsed.command === "sync") {
    const connection = await probeEntry({
      siteUrl: config.siteUrl,
      credentialProvider,
      fetchImpl
    });
    if (!connection.canScan) {
      const result = { schemaVersion: 1, connection };
      writeJson(output, result);
      return result;
    }
  }
  if (!config.siteUrl) throw new TypeError("Moodle site URL is required");

  const usesCliPrompt =
    parsed.command === "delivery.execute" && !confirmationProvider && input?.isTTY && output?.isTTY;
  const interactiveProvider = usesCliPrompt
    ? new MemoryConfirmationProvider()
    : confirmationProvider;
  if (parsed.command === "delivery.execute" && !interactiveProvider) {
    const error = new Error("A host confirmation provider is required for non-interactive delivery");
    error.code = "confirmation_provider_required";
    throw error;
  }
  const runtime = await createRuntime(config, {
    credentialProvider,
    confirmationProvider: interactiveProvider,
    fetchImpl
  });
  try {
    let commandInput = parsed.input;
    if (parsed.command === "delivery.execute") {
        if (!parsed.input.planHash) throw new TypeError("--plan-hash is required");
        let confirmationToken = parsed.input.confirmationToken;
        if (!confirmationToken && usesCliPrompt) {
          await confirmPlanHash({ planHash: parsed.input.planHash, input, output });
          confirmationToken = interactiveProvider.issue({
            binding: runtime.coordinator.getConfirmationBinding(parsed.input.planHash),
            expiresAt: Date.now() + 60_000
          });
        }
        if (!interactiveProvider) {
          const error = new Error("A host confirmation provider is required for non-interactive delivery");
          error.code = "confirmation_provider_required";
          throw error;
        }
        commandInput = {
          planHash: parsed.input.planHash,
          confirmationToken
        };
    }
    const result = await invokeRuntimeCommand(runtime, parsed.command, commandInput);
    writeJson(output, result);
    return result;
  } finally {
    runtime.close();
  }
}

async function main() {
  try {
    await runCli();
  } catch (error) {
    writeJson(process.stderr, {
      ok: false,
      code: error?.code || "invalid_request",
      message: String(error?.message || "Command failed")
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
