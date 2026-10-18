# git-forge

Serverless Git forge with built-in Git LFS and federated mirrors.

- Runs without a server of its own: functions (Cloudflare Workers first),
  S3-compatible object storage and an SQLite database.
- GitHub-like: repositories, issues, pull requests, discussions,
  organizations and teams, apps as machine accounts.
- Instances can mirror each other's repositories as backups. A backup instance
  is the same software whose repositories are mirrors, with its own storage
  and users. Every copy stays readable with a plain `git clone`, even without
  this software.

Status: Git core implemented, including server-side import and the
`git forge push` helper for large pushes; LFS, accounts, mirrors and
deployment in progress. See [docs/design.md](docs/design.md) and
[docs/roadmap.md](docs/roadmap.md).

To run an instance, start from the instance template in
[templates/instance](templates/instance) (later `levino/git-forge-instance`):
it pins a checksummed release bundle; nothing is installed from npm.

License: MIT.
