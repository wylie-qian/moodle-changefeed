#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const name = process.argv[2] || 'school';
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || process.argv.length > 3) {
  process.stderr.write('Usage: npm run setup:codex -- <profile-name>\n');
  process.exitCode = 1;
} else {
  const server = fileURLToPath(new URL('../src/mcp/server.mjs', import.meta.url));
  process.stdout.write(`# Add this section to your Codex config.toml. Restart the MCP connection afterwards.\n[mcp_servers.moodle_${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([path.resolve(server), '--profile', name])}\nstartup_timeout_sec = 30\ntool_timeout_sec = 180\n`);
}
