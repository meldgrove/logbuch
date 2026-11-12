# Contributing

Thank you for helping with Meldgrove Logbuch. Bug reports, ideas, and pull requests are
welcome.

## Development setup

Requirements: Node.js 26, npm, and Docker.

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL 18 (port 55432) and Keycloak (port 8090)
cp .env.example .env.local
npm ci
npm run db:migrate
npm run dev                                # http://localhost:3000
npm run worker                             # in a second terminal
```

`compose.yaml` is the production setup. To leave out `-f compose.dev.yaml` in
every Compose command, `export COMPOSE_FILE=compose.dev.yaml` in your shell.

Test users in the development Keycloak (password `logbuch-dev`): `erika`
(has access), `adam` (admin), and `olga` (no access). The Keycloak admin
console is at http://localhost:8090 (`admin` / `admin`).

## Checks

```sh
npm run lint
npm run typecheck
npm test                   # unit tests
npm run test:integration   # against the PostgreSQL from compose.dev.yaml
npm run build
```

End-to-end tests run against production builds; `AGENTS.md` lists the steps.
CI runs all of these on every pull request.

## Conventions

`AGENTS.md` describes the architecture and the rules the code follows: where
writes happen, how access is checked, how notifications and the webhook are
recorded, and why nothing is deleted. In short:

- Keep pages and Server Actions thin; put logic in `src/lib/<module>/`, with
  tests next to it.
- Change the database schema in `src/lib/db/schema.ts` and generate the
  migration with `npm run db:generate`.
- Add or change environment variables in `src/lib/config.ts` and document
  them in `docs/configuration.md`.
- UI text is English (US), short and plain.

## Pull requests

- One topic per pull request, with tests for new behavior.
- Describe what changes for users and admins, and how you tested it.
- Never commit secrets, real personal data, or data from a real organization,
  also not in tests and fixtures. Use `example.org` addresses.

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens weekly pull requests for npm,
GitHub Actions, the Docker base image, and the Compose images. Minor and
patch updates come grouped; a major update comes alone and may need code
changes. Two versions it cannot see; update them by hand in the same pull
request:

- `NODE_VERSION` in `.github/workflows/ci.yml`, with the `node` image in the
  `Dockerfile`.
- The Keycloak image in `.github/workflows/ci.yml`, with the one in
  `compose.dev.yaml`.

## Releases

A release bundles everything merged to `main` since the previous one.
Maintainers start it by hand; nothing is released on merge. A release is a
`vX.Y.Z` tag on a `main` commit that passed CI. No file holds the version
(`package.json` stays at `0.0.0`), and releasing pushes nothing to `main`.

**Version numbers** follow Semantic Versioning. Choose the smallest part that
fits the largest change:

- **Patch** (the default): fixes, dependency and base image updates, security
  fixes, and small changes to the interface or texts.
- **Minor:** anything new for users or admins (features, settings,
  integrations), database migrations, and changes admins must act on, for
  example a new required setting or a changed requirement (PostgreSQL,
  identity provider). The release notes say what to do.
- **Major:** rare, only for a really big update: a rewrite, a new architecture
  or deployment model, or the removal of a major feature. 1.0.0 is the
  maintainers' deliberate decision.

A minor version tag such as `0.1` therefore only receives patch releases,
which never need admin action.

**Release notes** come from the titles of the merged pull requests, so write
titles as release-note lines. Label a pull request `breaking` when admins
must act on upgrade, and describe the steps in it: the notes list it first,
under "Upgrade steps needed". Dependabot's pull requests (`dependencies`)
come last (`.github/release.yml`).

### Cut a release

1. Wait for CI to pass on the latest `main` commit.
2. Open **Actions → Release → Run workflow**, choose patch, minor or major,
   and tick **Dry run**. It builds and starts the image on amd64 and arm64
   and shows the version, image tags, and notes, without publishing.
3. Run it again without **Dry run**. When the release needs admin action,
   untick **Deploy** and deploy by hand after taking the steps.
4. When the release needs admin action, edit its notes on GitHub and put the
   steps at the top.

The `Release` workflow (`.github/workflows/release.yml`) stops without
changes when it was not started from `main`, when CI has not passed for that
commit, or when nothing changed since the last release. Otherwise it:

- raises the latest `vX.Y.Z` tag by the chosen part, tags the commit, and
  pushes only the tag. The first release starts from 0.0.0, so minor makes it
  0.1.0;
- publishes the image `ghcr.io/meldgrove/logbuch` for amd64 and arm64 as
  `X.Y.Z`, `X.Y`, from 1.0.0 also `X`, and `latest`;
- attests where the image was built and creates the GitHub Release;
- deploys the release to the maintainers' server, if the repository has a
  deploy link (below).

If a job fails after the tag was pushed, fix the cause and use **Re-run
failed jobs**: it publishes from the tag. Do not start a new release for the
same changes.

**Release candidates:** tick **Release candidate** to publish
`X.Y.Z-rc.N` for testing on a staging server. It publishes only that image
tag (never `latest`), marks the GitHub Release as a prerelease, and deploys
nothing. Release with the same choice of patch, minor or major afterwards.

Pull requests that change the `Dockerfile`, `.dockerignore`,
`docker-entrypoint.sh`, or the workflow build and start both images without
publishing. Release images set `APP_VERSION`: `/-/healthz` reports it, and
Sentry names the release `logbuch@X.Y.Z` unless `SENTRY_RELEASE` is set.

### Deploy after a release

The maintainers' server can install every release as soon as it is out. It
runs the image tag `latest` (`LOGBUCH_VERSION=latest`), and the repository has
two Actions secrets:

- `DEPLOY_HOOK_URL`: a link that redeploys the app on `POST`. In Coolify,
  the resource's **Webhooks** → **Deploy Webhook**.
- `DEPLOY_HOOK_TOKEN`: its bearer token. In Coolify, an API token with only
  the `deploy` permission.

The **Deploy** job calls the link once the release is published; without
`DEPLOY_HOOK_URL` it does nothing. GitHub's runners must reach the link over
the internet. If the call fails, the release is still out: fix the cause and
use **Re-run failed jobs**, or deploy by hand.

### Repository settings

- **Package visibility:** the GitHub Container Registry creates a new package
  as private. After the first release, an organization owner makes it public
  once: on the package page
  (https://github.com/orgs/meldgrove/packages/container/package/logbuch),
  **Package settings** → **Change visibility** → **Public**. Then check that
  `docker pull ghcr.io/meldgrove/logbuch:<version>` works without logging in.
- **Immutable releases** are on: a published release's tag can never move or
  be deleted, while its notes stay editable. Fix a bad release with a new
  patch release.
- **Protected `main`:** releases push only a tag, so a ruleset that requires
  pull requests on `main` needs no bypass actor. Do not restrict creating
  `v*` tags: the workflow pushes them with its own token.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
