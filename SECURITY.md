# Security

## What Skill Atlas does on your machine

Skill Atlas is a local tool. It starts an HTTP server bound to `127.0.0.1`, reads the
folders you add as projects, and runs `git` inside them when you use the **Version**
action. It makes no network requests of its own and sends nothing anywhere.

Because the server can read files and run git, it only answers requests addressed to
`localhost`, `127.0.0.1` or `[::1]`. Requests carrying any other `Host` header get a 403.
This blocks DNS-rebinding attacks, where a web page you visit resolves its own domain to
127.0.0.1 and talks to the server as if it were same-origin.

Files are only read or opened when the resolved path, symlinks included, stays inside the
project folder you added.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private reporting:
**Security → Report a vulnerability** on the repository, or email the maintainer listed
in `package.json`.

Include what you found, how to reproduce it, and which version or commit you tested.
You will get a reply within a week. Fixes ship as a patch release with a note in the
release description.

## Supported versions

Only the latest release receives fixes. There is no auto-update, so download the new
`.dmg` from the releases page when a security release is announced.
