# Dependency risk — accepted residual, and why

`npm audit --omit=dev` reports **29 vulnerabilities (1 critical, 9 high)** as of
2026-08-11. None are being fixed before the pilot launch. This document is the
reasoning, so the decision is reviewable rather than merely forgotten.

## Why they can't just be fixed

`npm audit fix` (non-breaking) resolves **zero** of them. Every remaining fix
requires upgrading `@nestjs/*` from **v10 to v11** — a major version bump across
the entire framework, touching the HTTP adapter, the WebSocket gateway, Swagger
and the CLI at once. Doing that hours before a launch, with no integration test
suite to catch what it breaks, is a far larger risk than the vulnerabilities
themselves.

## Why most of them can't be reached

The critical and most of the high findings are **build tooling that never runs
in production**. It sits in `dependencies` rather than `devDependencies` only
because of the Railway `--omit=dev` workaround documented in `nixpacks.toml` —
so `npm audit --omit=dev` counts it, but nothing ever executes it at runtime.

| Package | Severity | Reachable at runtime? |
|---|---|---|
| `tar` (via `bcrypt` → `@mapbox/node-pre-gyp`) | critical | **No.** Install-time only; fetches a prebuilt binary during `npm ci`. Never invoked serving a request. |
| `glob` CLI command injection | high | **No.** The exploit is the `glob` *CLI's* `-c/--cmd` flag. Nothing here shells out to it. Ships via `@nestjs/cli`. |
| `tmp` symlink write | high | **No.** `@nestjs/cli` scaffolding only. |
| `picomatch` glob matching | high | **No.** Build-time matcher. |
| `@nestjs/cli`, `@angular-devkit/core` | high | **No.** `nest build` runs at build time; `node dist/main` runs in production. |
| `multer` (via `@nestjs/platform-express`) | high | **Not in any code path.** No route accepts multipart. Uploads go client → R2 directly via presigned URLs (`src/uploads/`); files never transit this backend. |
| `js-yaml`, `lodash` (via `@nestjs/swagger`) | high | **Off in production.** `main.ts` only mounts Swagger when `NODE_ENV !== "production"` or `ENABLE_DOCS === "true"`. Keep `ENABLE_DOCS=false`. |

## What actually protects the pilot

The genuine attack surface is the request path, and that is guarded by things
that are in place and tested:

- `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` — undeclared body
  fields are rejected, not silently bound.
- `assertProductionConfig()` refuses to boot with missing/weak JWT secrets, a
  console SMS provider, or no CORS allowlist.
- Rate limiting backed by Redis, with tighter limits on the OTP endpoints.
- `LaunchPolicyService` enforces bike-only, fixed-fare, zone and hours
  server-side, so a modified client can't book outside the pilot.

## What to do after launch

1. Create a branch. Upgrade `@nestjs/*` to v11 together — they are version-locked to
   each other and a partial upgrade will not install.
2. Move `@nestjs/cli`, `@nestjs/schematics`, `typescript`, `ts-node` and
   `ts-loader` back to `devDependencies`, and make the Railway build use
   `npm ci --include=dev`. That alone removes the critical and most of the highs
   from the production tree, because they stop being production dependencies.
   Read the history comment in `nixpacks.toml` first — this was tried once and
   reverted, and the reason matters.
3. Re-run `npm audit --omit=dev` and update this file.

**Review by:** end of pilot week 1. If the pilot extends past that without this
being done, it stops being an accepted risk and becomes an ignored one.
