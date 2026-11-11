# Deployment

Logbuch ships as one Docker image. Its command selects the process:

| Command | What it does |
|---|---|
| `migrate` | Applies the SQL migrations in `drizzle/`, then exits. Run it before `web` and `worker` start, on every deployment |
| `web` | The Next.js server on port 3000 |
| `worker` | Background jobs: notifications, reminders, the webhook, and the Keycloak directory sync. One is enough; more can run, since jobs are coordinated through the database |
| `directory-sync` | Runs one Keycloak directory sync, then exits |

Logbuch needs PostgreSQL 18. Background jobs (pg-boss) keep their tables in
the `pgboss` schema of the same database.

## Docker Compose

[`compose.yaml`](../compose.yaml) runs `migrate`, `web`, and `worker`
against the PostgreSQL in `DATABASE_URL`:

```sh
cp .env.example .env
# Edit .env with the production values (docs/configuration.md): at least
# DATABASE_URL, LOGBUCH_BASE_URL, BETTER_AUTH_SECRET, the OIDC_* variables,
# and DIRECTORY with its settings. Remove NOTIFICATION_TRANSPORT (production
# sends for real).
docker compose up -d --build
```

On a platform that runs Compose files, create the PostgreSQL there and set
`DATABASE_URL` to its internal URL. Some platforms start each Compose project
in a network of its own, where that host name does not resolve (`migrate` logs
`getaddrinfo EAI_AGAIN` and fails after a minute): connect the application to
the network the database is in. Platforms that pass their one Compose file
with `-f` override `COMPOSE_FILE`, so `compose.postgres.yaml` does not work
there.

Put a reverse proxy that terminates TLS in front of `web` and use its public
URL as `LOGBUCH_BASE_URL`. Use exactly that URL: login redirects and links in
messages are built from it.

Set `TZ` to your organization's time zone (default UTC): deadlines end at
23:59, and reminders go out at 09:00, in that zone.

### PostgreSQL next to Logbuch

On a server without a PostgreSQL of its own,
[`compose.postgres.yaml`](../compose.postgres.yaml) adds one to the Compose
project and keeps its data in the `postgres-data` volume. Set these values in
`.env`; `COMPOSE_FILE` makes every `docker compose` command use both files:

```sh
COMPOSE_FILE=compose.yaml:compose.postgres.yaml
# openssl rand -hex 32: no characters that would need escaping in the URL
POSTGRES_PASSWORD=<password>
DATABASE_URL=postgres://logbuch:<password>@postgres:5432/logbuch
```

PostgreSQL takes the password once, when it creates the database at the first
start. Changing `POSTGRES_PASSWORD` later does not change it.

## Health checks

| Endpoint | Meaning |
|---|---|
| `GET /-/healthz` | Liveness: the process answers. No dependency checks |
| `GET /-/readyz` | Readiness: the database answers and every migration of this build is applied. 503 otherwise |

The worker writes a heartbeat file every 30 seconds;
`node dist/worker-healthcheck.mjs` fails when it is older than 90 seconds. The
admin page shows the worker's last heartbeat.

## Operations

- **Backups**: Logbuch never deletes entries, people, or the audit log, so
  the database backup is the safety net. Back up the whole database,
  including the `pgboss` schema.
- **Logs** are JSON lines on stdout. The `service` field names the process.
- **Admin page** (`/admin`): directory sync status, notification channels and
  failures, webhook deliveries, and the default periods of the decision
  process.
- **Upgrades**: deploy the new image; `migrate` applies new migrations before
  `web` and `worker` start.

## Importing old entries from a CSV file

`import-entries` logs updates, learnings, and decisions from before Logbuch,
for example from an old decision log or a chat channel. Fill the columns of
[`entry-import-template.csv`](entry-import-template.csv) (comma or semicolon
separated, UTF-8). Unknown columns are ignored.

| Column | Required | Content |
|---|---|---|
| `id` | yes | Unique per row, e.g. the ID in the old log. A row is imported once; running again only adds new rows |
| `type` | no | `update`, `learning`, or `decision` (default) |
| `title` | yes | Up to 120 characters (longer titles are shortened) |
| `date` | yes | When it was published or decided: `YYYY-MM-DD` or `DD.MM.YYYY` |
| `summary` | no | Up to 280 characters; defaults to the first paragraph of the decision text, or of the details |
| `details` | no | Markdown. Shown as **Context** for a decision |
| `rationale` | no | Markdown. For a decision it defaults to "Imported from an earlier decision log." |
| `impact` | no | `small`, `medium`, or `large`; empty shows as "not set" |
| `team` | no | Team name; defaults to `--team` |
| `affected_teams` | no | Names of active teams, separated by commas or semicolons |
| `tags` | no | Names of active tags, separated by commas or semicolons. Create missing tags on the admin page first |
| `related` | no | Ids of rows above in the same file, or of entries imported before |
| `links` | no | Up to 10 http(s) URLs, separated by spaces |

Decisions only:

| Column | Required | Content |
|---|---|---|
| `decider_email` | yes, unless `--fallback-decider` | Email address of a person with access |
| `decision_text` | no | The decision (Markdown); defaults to the title |
| `how_decided` | no | `integrative_process`, `role_decision`, `management_decision`, or `other` (default) |
| `involved_emails` | no | Email addresses, separated by commas, semicolons, or spaces |
| `reversibility` | no | `two_way` or `one_way`; empty counts as two-way when the decision is replaced |
| `why_one_way` | no | Why a one-way decision is hard to reverse |
| `effective_date` | no | `YYYY-MM-DD` or `DD.MM.YYYY` |

Run it in the `worker` container:

1. Copy the file in, or pipe it with `--file -`:
   `docker compose exec -T worker node dist/import-entries.mjs --file - … < entries.csv`.
2. Dry run: nothing is written; every record is printed in full, followed by
   a review fingerprint.

   ```sh
   node dist/import-entries.mjs --file /tmp/entries.csv --team "<team name>" --as <your email>
   ```

   `--as` must be an admin, who becomes the author of the records. If a
   decider has no access, add `--fallback-decider <email>`.
3. Read every record. Entries are visible to everyone with access, so leave
   out rows with personal data (`--skip <id>`, repeatable) or fix the file.
4. Run again with the same file and options and
   `--confirm-no-personal-data <fingerprint>`. It writes only if the file
   still yields exactly the records you reviewed. Imported entries keep their
   original date (noon in the server's time zone), are not posted to Slack,
   and are left out of the statistics.
