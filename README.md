# Logbuch

Logbuch is a self-hosted log of an organization's decisions, updates, and
learnings, with a built-in, consent-based decision process that works without
meetings.

- **One timeline** for updates, decisions, and learnings, with filters,
  full-text search, and a "Must read" pin for entries with a large impact.
- **Decision process**: a proposal collects questions, feedback, and
  objections from the people who are asked, then the decider publishes the
  decision. Two-way decisions (easy to reverse) move fast; one-way decisions
  need a Go from every consent giver on the current version.
- **Nothing is deleted.** Published decisions are never edited; corrections
  are addenda. Every change is versioned and recorded in an append-only audit
  log.
- **Login with any OpenID Connect provider** (Keycloak, Microsoft Entra ID,
  Google, Okta, Authentik, Zitadel, …).
- **People and teams** are managed in Logbuch (invitations), or synced from
  Keycloak groups.
- **Notifications** as Slack direct messages or emails (SMTP or MailerSend),
  reminders before deadlines, and one Slack channel post per new entry.
- **Webhook**: published entries are posted as signed JSON, for example to a
  search index or a knowledge base.
- **Personal preferences**: everyone chooses their time zone and date format.

## Quick start (development)

Requirements: Node.js 26, npm, and Docker.

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL 18 and a Keycloak with test users
cp .env.example .env.local
npm ci
npm run db:migrate
npm run dev                                # http://localhost:3000
npm run worker                             # in a second terminal: notifications and directory sync
```

Sign in as `erika` (has access), `adam` (admin), or `olga` (no access), each
with the password `logbuch-dev`. The development setup reads people and teams
from Keycloak groups; see [`.env.example`](.env.example) to try the manual
directory instead.

`compose.yaml` is the production setup, so a plain `docker compose up` runs
Logbuch itself; see [Deployment](docs/deployment.md).

## Documentation

- [Configuration](docs/configuration.md): every environment variable
- [Identity and access](docs/identity-and-access.md): OpenID Connect, the
  manual directory, and the Keycloak directory
- [Deployment](docs/deployment.md): Docker, health checks, operations, and the
  CSV import of old entries
- [Decision process](docs/decision-process.md): how proposals become
  decisions
- [Webhook](docs/webhooks.md): payload and signature
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md)

## Stack

Next.js 16 (App Router, Server Actions), TypeScript, PostgreSQL 18 with
Drizzle ORM, Better Auth, pg-boss, Tailwind CSS with shadcn/ui, Vitest, and
Playwright.

## License

Copyright 2026 Meldgrove

Licensed under the [Apache License 2.0](LICENSE).
