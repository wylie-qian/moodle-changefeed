import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function text(relativePath) {
  return readFile(path.join(packageRoot, relativePath), "utf8");
}

test("README quickstart commands execute without an account", async () => {
  const readme = await text("README.md");
  const section = readme.match(/## 60-second anonymous demo([\s\S]*?)(?=\n## )/)?.[1];
  assert.ok(section, "README must contain the exact anonymous demo section");
  const commands = [...section.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  assert.deepEqual(commands, [
    "node src/cli/main.mjs --help",
    "node src/cli/main.mjs demo --fixture anonymous/basic"
  ]);
  for (const command of commands) {
    const [executable, ...args] = command.split(" ");
    const result = await execute(executable, args, {
      cwd: packageRoot,
      env: { ...process.env, MOODLE_CHANGEFEED_TOKEN: "" }
    });
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /\/Users\/|MOODLE_CHANGEFEED_TOKEN=|wstoken/i);
  }
});

test("skill routes agents through stable bounded tools", async () => {
  const skill = await text("skills/moodle-changefeed/SKILL.md");
  for (const required of [
    "agent_bootstrap",
    "list_moodle_changefeed_capabilities",
    "get_moodle_change_feed",
    "set_moodle_review_decision",
    "prepare_moodle_delivery",
    "deliver_moodle_batch"
  ]) {
    assert.match(skill, new RegExp(`\\b${required}\\b`));
  }
  assert.match(skill, /review.*before.*delivery|审核.*交付/is);
  assert.match(skill, /stop.*confirmation|停止.*确认/is);
  assert.doesNotMatch(skill, /sqlite3|ledger\.sqlite|SELECT /i);
});

test("README and skill document generic compatibility onboarding", async () => {
  const [readme, skill] = await Promise.all([
    text("README.md"),
    text("skills/moodle-changefeed/SKILL.md")
  ]);

  const readmeOnboarding = readme.match(
    /## Connect a Moodle site([\s\S]*?)(?=\n## CLI)/
  )?.[1];
  const readmeApi = readme.match(
    /### Bootstrap API contract([\s\S]*?)(?=\n## MCP configuration)/
  )?.[1];
  const skillOnboarding = skill.match(
    /## Connection onboarding([\s\S]*?)(?=\n## API routing)/
  )?.[1];
  const skillApi = skill.match(
    /## API routing([\s\S]*?)(?=\n## Changefeed workflow)/
  )?.[1];

  assert.ok(readmeOnboarding, "README missing the user-visible onboarding section");
  assert.ok(readmeApi, "README missing the bootstrap API section");
  assert.ok(skillOnboarding, "skill missing the connection onboarding section");
  assert.ok(skillApi, "skill missing the API routing section");
  for (const visibleFlow of [readmeOnboarding, skillOnboarding]) {
    assert.match(visibleFlow, /site[\s\S]*authoriz[\s\S]*connected[\s\S]*scan/i);
    assert.doesNotMatch(
      visibleFlow,
      /authorization_required|compatible(?:_no_courses)?|capability_unavailable/
    );
    assert.doesNotMatch(
      visibleFlow,
      /\b(?:core|mod)_[a-z0-9_]+\b/i,
      "the onboarding checklist must not show a Web Service function checklist"
    );
  }
  assert.match(
    skillOnboarding,
    /canScan` is false[\s\S]*concrete recovery steps[\s\S]*do not call scan/i
  );
  assert.match(skillOnboarding, /canScan` is true[\s\S]*continue to scan/i);
  assert.match(
    skillApi,
    /capability_unavailable[\s\S]*optional feature[\s\S]*continue unrelated available capabilities/i
  );

  for (const [name, document] of [["README", readme], ["skill", skill]]) {
    for (const required of [
      "bootstrap --site-url",
      "authorization_required",
      "compatible",
      "capability_unavailable"
    ]) {
      assert.ok(document.includes(required), `${name} missing ${required}`);
    }
    assert.doesNotMatch(
      document,
      /moodle-changefeed\s+[^\n`]*--(?:token|moodle-token|webservice-token)\b/i,
      `${name} must not instruct users to pass a token in argv`
    );
  }
  assert.doesNotMatch(
    readme.replace(readmeApi, ""),
    /authorization_required|compatible(?:_no_courses)?|capability_unavailable/,
    "README machine codes belong only in its API section"
  );
  assert.doesNotMatch(
    skill.replace(skillApi, ""),
    /authorization_required|compatible(?:_no_courses)?|capability_unavailable/,
    "skill machine codes belong only in its API section"
  );
});

test("public docs and repository policy contain release safety boundaries", async () => {
  const [readme, security, license, ignore, workflow] = await Promise.all([
    text("README.md"),
    text("SECURITY.md"),
    text("LICENSE"),
    text(".gitignore"),
    text(".github/workflows/ci.yml")
  ]);
  for (const heading of [
    "Problem", "60-second anonymous demo", "Architecture", "CLI", "MCP configuration",
    "Source capability matrix", "Review and confirmation model", "Local archive",
    "Custom adapter", "Privacy and compliance limits", "Development", "Roadmap"
  ]) {
    assert.match(readme, new RegExp(`## ${heading.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
  }
  assert.match(readme, /not legal advice/i);
  assert.match(security, /never.*write.*Moodle|Moodle writes.*unsupported/is);
  assert.match(security, /credentials are site-bound/i);
  assert.match(security, /foreign site.*anonymous-only/is);
  assert.match(security, /must not.*credentials configured for another site/is);
  assert.match(security, /at most three redirects[\s\S]*exact original origin/i);
  assert.match(security, /fixed invalid sentinel[\s\S]*never substitutes a real token/i);
  assert.match(license, /Copyright \(c\) 2026 moodle-changefeed contributors/);
  for (const pattern of [".env*", "*.sqlite*", "node_modules/", "cache/", "staging/", "*.tgz"] ) {
    assert.ok(ignore.includes(pattern), `missing ignore pattern: ${pattern}`);
  }
  for (const required of [
    "actions/checkout", "actions/setup-node", "npm ci", "npm test", "npm run demo",
    "npm run audit:public", "npm run verify:release", "ubuntu-latest", "macos-latest", "22"
  ]) {
    assert.ok(workflow.includes(required), `missing CI step: ${required}`);
  }
  assert.doesNotMatch(workflow, /secrets\.|upload-artifact/);
});
