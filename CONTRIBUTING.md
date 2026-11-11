# Contributing

Thank you for helping with Logbuch. Bug reports, ideas, and pull requests are
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

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
