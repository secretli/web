# Secretli web

The web app of [Secretli](https://secretli.app): share text and files through links that open once and expire, encrypted in the browser before anything leaves it.

It is a React single-page app, built with Vite and served as static files by nginx. The API is a separate service, [secretli/server](https://github.com/secretli/server); in production a gateway sends `/api/` there and everything else here, so both share one origin. The encryption comes from [secretli/format](https://github.com/secretli/format), the same format the [command-line client](https://github.com/secretli/cli) speaks, so links work in either.

## Development

Prerequisites: Node 24 and pnpm 10. The dev server needs an API to talk to; start one from a checkout of secretli/server (`docker compose -f docker/docker-compose.yml --profile app up -d` there), or run the whole stack described below.

```bash
pnpm install
pnpm dev         # Vite on http://localhost:5173, proxying /api to http://localhost:8080
pnpm test        # unit tests
pnpm lint        # Biome
pnpm build       # production build into dist/
```

## The whole stack

`e2e/stack` runs Secretli as production does: this app's image and the server's image behind a gateway that splits `/api/` from the rest, with PostgreSQL and SeaweedFS, on `http://localhost:8080`.

```bash
e2e/stack/stack.sh up      # builds this image, starts everything, waits until it answers
e2e/stack/stack.sh down
```

The server image defaults to the latest published one. To use another, such as one built from a server checkout, set `SERVER_IMAGE`:

```bash
docker build -t secretli-server:local ../server
SERVER_IMAGE=secretli-server:local e2e/stack/stack.sh up
```

The footer shows the commit of each build. Locally the web app's is `dev`; set `WEB_VERSION` to a commit to see it as it appears in production.

## End-to-end tests

With the stack up:

```bash
e2e/stack/static-checks.sh    # headers, routing and content types of the image, through the gateway
pnpm e2e                      # Playwright, with axe accessibility checks on every screen
pnpm e2e:large                # opt-in: a near-limit upload and download, with timing and heap samples
```

The browser tests run one at a time, because the server allows ten new secrets a minute per address and every test comes from the same one. Set `SECRETLI_CLI` to a `secretli` binary and they also check that links made by the command-line client open in the browser and the other way round. CI does all of this against a server built from secretli/server's main branch; a weekly workflow runs the large-file test.

## The image

nginx, unprivileged, on port 8080, built for `linux/amd64` and `linux/arm64`:

- **Security headers** on every response: a content security policy that allows nothing but this origin, no framing, no referrer, and the camera for this origin only, for the QR scanner.
- **Caching:** the hashed files under `/assets/` are cached for a year; the index, the service worker and the manifest are revalidated on every load, so a deploy reaches everyone at once.
- **Routing:** any path that is not a file serves the app's index, which routes in the browser. `/api/` answers with a JSON 404, in case a request ever arrives here instead of at the server. `/healthz` is for the orchestrator's probes.

Every change on `main` that passes CI is published to the GitHub Container Registry as `ghcr.io/secretli/web:main`, `:sha-<commit>` and `:<YYYYMMDD-HHmmss>-<commit>`, with an SBOM, SLSA provenance and a keyless cosign signature:

```bash
cosign verify ghcr.io/secretli/web:main \
  --certificate-identity-regexp 'https://github.com/secretli/web/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## The format library

`@secretli/format` is a dependency on a release archive of secretli/format, pinned by URL in `package.json` and by hash in the lockfile. Dependabot cannot follow such a dependency, so a new format release is adopted by hand:

```bash
pnpm add https://github.com/secretli/format/releases/download/v0.2.0/secretli-format-0.2.0.tgz
```

## License

[MIT](LICENSE)
