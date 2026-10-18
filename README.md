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

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/levino/git-forge)

The button deploys the Cloudflare Worker in
[apps/forge-worker](apps/forge-worker) with its own R2 bucket and D1
database. A Workers Paid plan is required. After deploying, create the first
admin with the `BOOTSTRAP_TOKEN` you entered (see
[apps/forge-worker/README.md](apps/forge-worker/README.md#first-admin)).

Status: Git core, Git LFS, accounts with personal access tokens, instance
federation and mirrors work on Cloudflare Workers; the web UI and
collaboration features are next. See [docs/design.md](docs/design.md) and
[docs/roadmap.md](docs/roadmap.md).

License: MIT.
