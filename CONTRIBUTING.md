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
Maintainers start it by hand; nothing is released on merge.

**Version numbers** follow Semantic Versioning, judged by what admins must do
to upgrade:

- **Major:** the upgrade needs admin action, for example a new required
  setting, a changed requirement (PostgreSQL, identity provider), or a
  migration with manual steps.
- **Minor:** new features, and migrations that need no admin action.
- **Patch:** fixes and dependency updates.

Before 1.0.0, a minor release may also need admin action.

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
3. Run it again without **Dry run**.
4. When the release needs admin action, edit its notes on GitHub and put the
   steps at the top.

The `Release` workflow (`.github/workflows/release.yml`) stops without
changes when it was not started from `main`, when CI has not passed for that
commit, when nothing changed since the last release, or when `package.json`
does not hold the version of the latest release. Otherwise it:

- raises the version in `package.json` and `package-lock.json`, commits
  `chore(release): vX.Y.Z`, tags it, and pushes both together. If `main`
  moved during the run, neither lands; start it again. The first release
  keeps the version already in `package.json`.
- publishes the image `ghcr.io/meldgrove/logbuch` for amd64 and arm64 as
  `X.Y.Z`, `X.Y`, from 1.0.0 also `X`, and `latest`;
- attests where the image was built and creates the GitHub Release.

If a job fails after the tag was pushed, fix the cause and use **Re-run
failed jobs**: it publishes from the tag. Do not start a new release for the
same changes.

**Release candidates:** tick **Release candidate** to publish
`X.Y.Z-rc.N` for testing on a staging server. It tags the current commit
without changing `package.json`, publishes only that image tag (never
`latest`), and marks the GitHub Release as a prerelease. Release with the same
choice of patch, minor or major afterwards.

Pull requests that change the `Dockerfile`, `.dockerignore`,
`docker-entrypoint.sh`, or the workflow build and start both images without
publishing. Release images set `APP_VERSION`: `/-/healthz` reports it, and
Sentry names the release `logbuch@X.Y.Z` unless `SENTRY_RELEASE` is set.

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
- **Protected `main`:** the workflow pushes the version commit straight to
  `main` with its own token. Once a ruleset requires pull requests on `main`,
  give that push to a GitHub App that may bypass the ruleset: create an app
  owned by the organization, without a webhook, with the repository
  permission Contents: Read and write, and install it on this repository
  only. Add it as a bypass actor to the rulesets for `main` and `v*` tags.
  Set the repository variable `RELEASE_APP_CLIENT_ID` to its client ID and
  the secret `RELEASE_APP_PRIVATE_KEY` to a private key of the app.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
