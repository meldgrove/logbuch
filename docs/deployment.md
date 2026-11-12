# Deployment

Logbuch ships as one Docker image, `ghcr.io/meldgrove/logbuch`, for
linux/amd64 and linux/arm64. Each [release](https://github.com/meldgrove/logbuch/releases)
is tagged with its version (`0.1.0`) and its minor version (`0.1`, which moves
to the newest patch release), from 1.0.0 also its major version (`1`);
`latest` is the newest release. Release candidates (`0.2.0-rc.1`) are for
testing and get only their own tag. Run a fixed version and upgrade on
purpose, or let the updater install new releases ([automatic
updates](#automatic-updates)): a new release can bring database migrations
and new settings, which its release notes name. The image's command selects
the process:

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
against the PostgreSQL in `DATABASE_URL`. Take it from the release you deploy,
together with `.env.example` as the start of your `.env`:

```sh
version=0.1.0   # the release to deploy
curl -fsSLO "https://raw.githubusercontent.com/meldgrove/logbuch/v$version/compose.yaml"
curl -fsSL -o .env "https://raw.githubusercontent.com/meldgrove/logbuch/v$version/.env.example"
# Edit .env with the production values (docs/configuration.md): at least
# DATABASE_URL, LOGBUCH_BASE_URL, BETTER_AUTH_SECRET, the OIDC_* variables,
# and DIRECTORY with its settings. Remove NOTIFICATION_TRANSPORT (production
# sends for real). Add the release:
#   LOGBUCH_VERSION=0.1.0
docker compose up -d
```

`LOGBUCH_VERSION` is required: Compose stops with a message without it.

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
[`compose.postgres.yaml`](../compose.postgres.yaml) (from the same release)
adds one to the Compose project and keeps its data in the `postgres-data` volume. Set these values in
`.env`; `COMPOSE_FILE` makes every `docker compose` command use both files:

```sh
COMPOSE_FILE=compose.yaml:compose.postgres.yaml
# openssl rand -hex 32: no characters that would need escaping in the URL
POSTGRES_PASSWORD=<password>
DATABASE_URL=postgres://logbuch:<password>@postgres:5432/logbuch
```

PostgreSQL takes the password once, when it creates the database at the first
start. Changing `POSTGRES_PASSWORD` later does not change it.

### Checking the image

Every release image carries a provenance attestation, signed by GitHub, that
names the commit and the workflow run it was built from. With the
[GitHub CLI](https://cli.github.com):

```sh
gh attestation verify oci://ghcr.io/meldgrove/logbuch:0.1.0 --repo meldgrove/logbuch
```

### Building the image yourself

To run your own build, for example of a change that is not released yet, build
the image from a clone of the repository and give it a version of its own:

```sh
docker build -t ghcr.io/meldgrove/logbuch:local .
# In .env: LOGBUCH_VERSION=local
docker compose up -d
```

## Health checks

| Endpoint | Meaning |
|---|---|
| `GET /-/healthz` | Liveness: the process answers, with the release version (`null` for images built from source). No dependency checks |
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
- **Upgrades**: read the release notes of every release since yours, set
  `LOGBUCH_VERSION` to the new release, and run `docker compose up -d`.
  `migrate` applies new migrations before `web` and `worker` start. Back up
  the database first: migrations only move forward.

## Automatic updates

`compose.yaml` includes the `updater` service of
[Meldgrove Updater](https://github.com/meldgrove/updater). Once an hour it
checks whether the tag in `LOGBUCH_VERSION` points to a new image. If so, it
calls the deploy link of the platform, which pulls the image and restarts
Logbuch, `migrate` first. Until `UPDATE_DEPLOY_HOOK_URL` is set, it does
nothing.

1. Set `LOGBUCH_VERSION` to a tag that moves:
   - a minor version such as `0.2`: its patch releases, which never need
     manual steps;
   - `latest`: every release. A release with upgrade steps then installs
     before anyone has taken them; watch the releases on GitHub (Watch →
     Custom → Releases) and take the steps right away.
2. Schedule database backups: migrations run without anyone watching.
3. Set `UPDATE_DEPLOY_HOOK_URL` to the platform's deploy link, which must
   redeploy on `POST`, and `UPDATE_DEPLOY_HOOK_TOKEN` to its bearer token if
   it needs one. For Coolify, the updater's
   [README](https://github.com/meldgrove/updater#coolify) shows where to find
   both.
4. Deploy once. The `updater` log then says which tag it watches.

Without a platform, leave the deploy link empty and let cron run
`docker compose up --detach --pull always --quiet-pull` every hour instead.

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
