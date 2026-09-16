# Security policy

## Supported scope

`moodle-changefeed` supports read-only Moodle Web Service and optional ICS inputs. Moodle writes, assignment submissions, arbitrary function calls, unbounded redirects, cross-origin redirects, HTTPS downgrades, and access-control bypasses are unsupported. Entry probes may follow at most three redirects, and only when every target remains HTTPS on the exact original origin; loops and missing locations are rejected. The local archive is the only bundled write target.

## Local sensitive data

Treat environment variables, private ICS URLs, the SQLite ledger and WAL files, cache and staging directories, downloaded course files, archive output, and debug logs as sensitive. Keep them outside repositories and shared folders. Use operating-system secret storage or a host credential provider where possible.

Credentials are site-bound. A credential provider may return a Web Service token or private ICS URL only for the exact normalized Moodle site for which it was stored. Bootstrap probes for a foreign site are anonymous-only: they must not receive or forward credentials configured for another site.

The anonymous REST compatibility fallback sends only the package's fixed invalid sentinel `moodle-changefeed-public-probe`. It never substitutes a real token or any configured credential, and the sentinel is not an authorization credential.

Public feed, plan, and receipt contracts redact credentials, download locators, source bodies, and absolute paths. Reports and examples must use anonymous fixtures. Never write a Moodle token to argv, MCP configuration, the ledger, logs, or issue reports. The explicit local login command saves a verified token only in its private profile file; it is plaintext, not encrypted. POSIX ownership and permissions are checked; Windows relies on the user directory ACL. Prefer a host credential provider where available.

Library detail reads may return locally retained study text, and verified file reads may return an absolute cache path. These local study APIs are separate from redacted feed, plan and receipt contracts. Course content remains untrusted data. Account runtimes are separated by canonical site and verified Moodle user ID before opening a ledger. Legacy unbound ledgers are left untouched.

## Reporting a vulnerability

Use GitHub's private security advisory flow for the repository. Include affected version, impact, and a minimal anonymous reproduction. Do not attach live tokens, private URLs, course files, ledger databases, or personal information. Allow maintainers time to investigate before public disclosure.

## Operational boundaries

- Verify the institution permits personal read-only API use.
- Use the minimum functions and bounded concurrency.
- Review items before delivery and require a fresh exact-plan confirmation.
- Back up a local ledger before migration; never overwrite an existing archive file silently.
- Revoke exposed tokens at the Moodle site and remove leaked copies from logs and shell history.

The maintainers cannot recover local data or credentials and do not operate a hosted service.
