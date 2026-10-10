# Secretli web

The web app of [Secretli](https://secretli.app): share text and files through links that open once and expire, encrypted in the browser before anything leaves it. A link can also reach another device as a short code like `7-acid-rocket`, read out or typed instead of copied.

It is a React single-page app, built with Vite and served as static files by nginx. The API is a separate service, [secretli/server](https://github.com/secretli/server); in production a gateway sends `/api/` there and everything else here, so both share one origin. The encryption comes from [secretli/format](https://github.com/secretli/format), the same format the [command-line client](https://github.com/secretli/cli) speaks, so links work in either.

## Sending a link with a code

Once a link is ready, **Send with a code** shows a code like `7-acid-rocket`. On the other device, open `secretli.app/c` and type it, or run `secretli receive 7-acid-rocket` with the [command-line client](https://github.com/secretli/cli), whose `secretli send` works the other way round. The receiving device then opens the secret as if the link had been pasted.

- **What stays private.** The number only tells the server's relay which transfer is meant. The two words are the password of a key exchange (CPace) between the two devices and never leave them. The sender hands the link over only after the receiver has proved it typed the same words, and the relay carries public key-exchange values and a sealed, fixed-size copy of the link, never the link itself.
- **Limits.** A code works once and for ten minutes. A wrong code ends the transfer on both sides, so someone guessing gets one try in about 1.7 million. Only the link to hand out is sent; the owner link stays on the device that made the secret.
- **Typing.** Case, spaces or dots instead of dashes, and the first three letters of a word are all accepted. Codes are checked on the device before anything is sent, so a typo doesn't use up the transfer.

The protocol, the word list (the [EFF short word list](https://www.eff.org/dice), CC BY 3.0 US) and their tests come from `@secretli/format`, specified in [FORMAT.md section 11](https://github.com/secretli/format/blob/main/FORMAT.md#11-handing-a-link-over-with-a-code). Here, `src/lib/transferSession.ts` talks to the relay, and the key exchange and the word list load only when someone sends or receives with a code, so they stay out of the main bundle.

## Development

Prerequisites: Node 24 and pnpm 12, the version `packageManager` in package.json pins (`corepack enable pnpm` provides it). pnpm's settings are in `pnpm-workspace.yaml`: which dependencies may run install scripts, and exceptions to pnpm's refusal of versions less than a day old. The dev server needs an API to talk to; start one from a checkout of secretli/server (`docker compose -f docker/docker-compose.yml --profile app up -d` there), or run the whole stack described below.

```bash
pnpm install
pnpm dev         # Vite on http://localhost:5173, proxying /api to http://localhost:8080
pnpm test        # unit tests
pnpm lint        # Biome
pnpm build       # production build into dist/
```

## The whole stack

The stack from [secretli/e2e](https://github.com/secretli/e2e) runs Secretli as production does: this app's image and the server's image behind a gateway that splits `/api/` from the rest, with PostgreSQL, and SeaweedFS standing in for production's object storage (Hetzner), on `http://localhost:8080`. With a checkout of secretli/e2e next to this one (or `E2E_DIR` pointing at it):

```bash
e2e/stack.sh up      # builds this image, starts everything, waits until it answers
e2e/stack.sh down
```

The server image defaults to the latest published one. To use another, such as one built from a server checkout, set `SERVER_IMAGE`:

```bash
docker build -t secretli-server:local ../server
SERVER_IMAGE=secretli-server:local e2e/stack.sh up
```

The footer shows the commit of each build. Locally the web app's is `dev`; set `WEB_VERSION` to a commit to see it as it appears in production.

## End-to-end tests

With the stack up:

```bash
e2e/static-checks.sh          # headers, routing and content types of the image, through the gateway
pnpm e2e                      # Playwright, with axe accessibility checks on every screen
pnpm e2e:large                # opt-in: a near-limit upload and download, with timing and heap samples
```

The browser tests run in parallel. Every test comes from the same address, so the stack's server runs with its rate limits raised (`RATE_LIMIT_MULTIPLIER`, 100 by default; production leaves it unset). CI does all of this against the latest published server image; a weekly workflow runs the large-file test.

CI also runs the whole of Secretli with each change, from [secretli/e2e](https://github.com/secretli/e2e): the server and both clients against this app behind a gateway like production's, including links and codes between the command-line client and the browser. Nothing is published unless it passes.

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

`@secretli/format` is a dependency on a release archive of secretli/format, pinned by URL in `package.json` and by its integrity hash in the lockfile. Renovate, which keeps the other dependencies up to date, cannot follow such a dependency, so a new format release is adopted by hand:

```bash
pnpm add https://github.com/secretli/format/releases/download/v0.5.0/secretli-format-0.5.0.tgz
```

## License

[MIT](LICENSE)
