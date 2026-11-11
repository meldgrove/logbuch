# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them
privately through GitHub: on the repository's **Security** tab, choose
**Report a vulnerability**.

Include what you found, how to reproduce it, and the impact you expect. We
will confirm receipt, keep you informed while we work on a fix, and credit you
in the release notes unless you prefer otherwise.

## Supported versions

Security fixes go into the latest release and the `main` branch.

## Deployment notes

- Generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`. Logbuch
  refuses to start in production with the example value from `.env.example`.
- Serve Logbuch over HTTPS only, and set `LOGBUCH_BASE_URL` to that HTTPS URL.
- The Keycloak service account needs only the `view-users` role of
  `realm-management`.
- Set `OIDC_TRUST_EMAIL=true` only if people cannot choose their own email
  address at your identity provider.
- Use a long, random `WEBHOOK_SECRET`, and verify the signature on every
  request your receiver gets (see [docs/webhooks.md](docs/webhooks.md)).
