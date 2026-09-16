# Changelog

## Unreleased — portable onboarding and study library

- Add local browser callback/token login, private account profiles and identity-separated runtimes.
- Add live course listing, current material search, item text and verified cached-file access through CLI/MCP.
- Preserve partial observations separately from the complete diff baseline; report observation freshness.
- Document executable Codex onboarding and generate absolute-path TOML configuration.
- Bound Web Service calls, degrade optional ICS failures and repair corrupt cache objects without overwriting unknown paths.
- Retain bounded study text locally; public feeds and delivery contracts remain redacted.
- Existing unbound data directories are not migrated automatically. The local ledger migration is additive; back up existing ledgers before upgrading.


All notable changes to this project will be documented here.

## Unreleased

### Added

- Deterministic Moodle normalization, diffing, versioned review feed, and SQLite ledger.
- Bounded Mobile/Web Service and optional ICS source adapters.
- Content-addressed resource cache and no-overwrite local archive adapter.
- Framework-neutral CLI, stdio MCP server, anonymous demo, and agent handoff skill.
- Closed delivery plans, host-owned confirmation, and idempotent receipts.
- Compact sync summaries that keep per-item course data behind the paginated review feed.
