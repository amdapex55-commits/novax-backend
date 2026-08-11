# Nova Go Logistics — Backend (Auth, Users, Trips, Live Location, Delivery, Uploads, Ledger, Ratings)

This is the engineering roadmap in progress: a NestJS modular monolith, built so it can
grow into delivery/freight without a rewrite. See `NovaGo_Engineering_Roadmap.docx` for
the full architecture this fits into.

## What's here

- **Auth module** — phone OTP login (`request` → `verify`), JWT access + refresh tokens
  (refresh tokens stored hashed, rotated on use).
- **Users module** — profile read/update, admin-only driver KYC approval, role-based
  access control (`RIDER` / `DRIVER` / `ADMIN`).
- **Location module** — WebSocket gateway (`/location` namespace) where drivers push GPS
  pings, backed by Redis `GEOADD`/`GEOSEARCH` for fast "who's nearby" queries. Riders
  join a `trip:<id>` room to get their matched driver's position pushed live.
- **Trips module** — booking, fare estimation (base + per-km + per-min, same shape as
  Bykea's transparent metered pricing), and matching: expanding-radius nearest-driver
  search, a 15-second accept window per offer, auto-cascade to the next driver on
  decline/timeout. Full state machine: `REQUESTED → MATCHING → MATCHED → IN_PROGRESS →
  COMPLETED` (or `CANCELLED` from any pre-trip state).
- **Delivery module** — parcel jobs with the same matching pattern as Trips (kept as a
  separate implementation, not a shared base class — see the comment at the top of
  `delivery.service.ts` for why). State machine: `REQUESTED → MATCHING → MATCHED →
  PICKED_UP → IN_TRANSIT → DELIVERED` (or `CANCELLED`). Supports cash-on-delivery
  (`codAmount`) and a proof-of-delivery URL field, ready for the R2 upload flow.
- **Uploads module** — `POST /api/v1/uploads/presign` returns a short-lived R2 URL the
  client PUTs a file to directly (KYC docs, proof-of-delivery photos, profile photos) —
  files never pass through this backend. Content-type is whitelisted server-side
  (`presign-upload.dto.ts`) so a client can't ask you to presign arbitrary file types.
  **Verified by actually running the signing code** against a dummy R2 endpoint (not
  just type-checked) — that test caught a real bug: the AWS SDK defaults to
  virtual-hosted-style URLs, which R2 doesn't support. Fixed with `forcePathStyle: true`
  in `uploads.service.ts`, with the reasoning left as a comment there.
- **Ledger module** — `TripsService.completeTrip()` and `DeliveryService.markDelivered()`
  now write a real `LedgerEntry` on completion: 15% platform commission (undercutting
  Bykea's 20% — see `commission.util.ts`), driver payout net of commission, and for
  deliveries with `codAmount` set, a COD liability entry so cash the driver is holding
  nets against their payout instead of vanishing. `GET /api/v1/wallet/balance` and
  `GET /api/v1/wallet/history` expose it. **The commission split math was actually run
  and checked** (not just type-checked) against the invariant that
  `net + commission == gross` for typical, fractional, zero, and custom-rate cases.
- **Ratings module** — `POST /api/v1/trips/:id/rate` and `POST /api/v1/deliveries/:id/rate`
  let the rider/sender rate the driver once, after completion (a unique constraint on
  `Rating.tripId`/`deliveryId` blocks a second rating, surfaced as a clean 400 instead of
  a raw database error). Recalculates and updates the driver's `User.rating` average.
- **Prisma schema** — `User`, `DriverProfile`, `OtpCode`, `RefreshToken`, `Trip`,
  `Delivery`, `LedgerEntry`, `Rating`. Every relation between models was manually
  audited for Prisma's "ambiguous relation" trap (two FKs to the same model needing an
  explicit `@relation("name")`) — `Trip`, `Delivery`, and `Rating` each have two
  relations to `User` and are all correctly named; this is the one file `tsc` can't
  validate at all in a sandbox where `prisma generate` is blocked, so it got a manual
  line-by-line check instead.
- **Matching state now lives in Redis**, not memory — `TripsService` and
  `DeliveryService` used to track "which drivers already declined this trip" in a
  plain in-memory `Map`, which loses all in-flight matches on every restart and breaks
  outright the moment there's a second backend instance. `ExcludedDriversStore`
  (`src/location/excluded-drivers.store.ts`) replaces it with a TTL'd Redis set, shared
  by both modules.
- **Rate limiting** — tight limits on OTP endpoints specifically, since that's the one
  that costs you real money if abused.
- **Swagger docs** — auto-generated at `/api/docs` once the server is running.

### How matching actually works right now

1. Rider calls `POST /api/v1/trips` → trip saved as `REQUESTED`, fare estimated from
   straight-line distance (swap for a real routing API later — see `fare.util.ts`).
2. Backend searches Redis at growing radii (1km → 3km → 5km → 8km) for the nearest
   available driver, sets the trip to `MATCHING`, and pushes a `trip:offer` event to
   that driver's socket.
3. Driver has 15 seconds to `POST /api/v1/trips/:id/accept`. No response, or a
   `POST .../decline`, and the backend automatically offers the next-nearest driver.
4. On accept, both rider and driver get a `trip:matched` socket event. The rider's app
   should then emit `trip:subscribe` with the trip id to start receiving the driver's
   live position on `trip:driverLocation`.
5. `POST .../start` and `POST .../complete` move the trip through to completion.

This is intentionally the simple version — see the roadmap's Section 15 (Scaling) for
when to add ETA-based ranking, acceptance-rate weighting, or surge pricing on top.

## Run it locally

1. **Start Postgres + Redis:**
   ```bash
   docker compose up -d
   ```
2. **Install dependencies** (already done if you got this folder from me directly —
   `node_modules` isn't included in the handoff, run this fresh):
   ```bash
   npm install
   ```
3. **Set up your environment file:**
   ```bash
   cp .env.example .env
   ```
   The defaults match `docker-compose.yml`, so you shouldn't need to change anything to
   run locally. `SMS_PROVIDER=console` means OTP codes print to your terminal instead of
   sending real texts — good for testing without a Twilio bill.
4. **Generate the Prisma client and create the database tables:**
   ```bash
   npx prisma generate
   npx prisma migrate dev --name init
   ```
   > Note: I built this scaffold in a sandboxed environment that blocks Prisma's engine
   > download (`binaries.prisma.sh`), so I could type-check the code but not run this
   > step myself. Everything else compiled clean — the only errors were "Prisma client
   > not generated yet," which resolves the moment you run this command with normal
   > internet access.
5. **Run the server:**
   ```bash
   npm run start:dev
   ```
   API docs: http://localhost:3000/api/docs

## Try it

```bash
# 1. Request an OTP (check your terminal — SMS_PROVIDER=console logs it instead of texting)
curl -X POST http://localhost:3000/api/v1/auth/otp/request \
  -H "Content-Type: application/json" \
  -d '{"phone":"+923001234567"}'

# 2. Verify it (use the code from your terminal log)
curl -X POST http://localhost:3000/api/v1/auth/otp/verify \
  -H "Content-Type: application/json" \
  -d '{"phone":"+923001234567","code":"123456"}'
# → returns { accessToken, refreshToken }

# 3. Call a protected route
curl http://localhost:3000/api/v1/users/me \
  -H "Authorization: Bearer <accessToken>"
```

## Next steps

1. Swap `fare.util.ts`'s straight-line distance for a real routing API (Google
   Directions/Mapbox) once accuracy matters more than speed of building.
2. Add a driver-facing "settle up" flow — mark a batch of `LedgerEntry` rows as paid
   out (e.g. via bank transfer/JazzCash) so `getBalance()` reflects what's still owed
   rather than the all-time total.
3. Push this repo to a private GitHub repo, wire up GitHub Actions (test → build →
   deploy), and connect it to Railway or Render for a live staging environment.

## Push to GitHub

```bash
git init
git add .
git commit -m "Phase 1: auth + users"
git branch -M main
git remote add origin <your-private-repo-url>
git push -u origin main
```

## Deploy (Railway, MVP hosting)

1. Create a Railway project, add a Postgres plugin (with PostGIS — Railway's Postgres
   image supports enabling the extension) and a Redis plugin.
2. Connect this GitHub repo — Railway auto-detects the NestJS build.
3. Set the same environment variables from `.env.example` in Railway's dashboard,
   pointing `DATABASE_URL`/`REDIS_URL` at the managed instances it created.
4. Point Railway's health check at **`/health/ready`** (not `/health`) — see below.
5. Push to `main` → auto-deploys.

### ⚠️ One-time: baseline the existing production database

The deploy command changed from `prisma db push` to `prisma migrate deploy`, and the
first real migration (`prisma/migrations/0_init/`) has been added.

**The existing production database already has these tables** — created by the old
`db push` — but has no `_prisma_migrations` table to prove it. `migrate deploy` sees a
non-empty schema it has no record of creating and refuses to touch it:

```
Error: P3005 The database schema is not empty.
```

So the next deploy fails until you tell Prisma "these tables are already here". Run this
**once**, locally, with `DATABASE_URL` pointing at the production database:

```bash
DATABASE_URL="<railway-postgres-url>" npx prisma migrate resolve --applied 0_init
```

That only inserts a row into `_prisma_migrations`; it runs none of the SQL and changes no
tables. Verify with `npx prisma migrate status` — it should say the database is up to
date — then deploy. Every migration after this one applies normally.

> A brand-new database (a fresh staging environment, or a local `docker compose` volume
> you've never pushed to) needs none of this — `migrate deploy` just applies `0_init`
> from scratch.

### Health checks

- **`GET /health`** — liveness. Always 200 while the process is serving. No dependency
  checks, deliberately: a Postgres outage shouldn't get the container killed and
  restarted, because restarting fixes nothing. Point uptime monitors here.
- **`GET /health/ready`** — readiness. Pings Postgres and Redis in parallel (2s timeout
  each) and returns **503** if either is unreachable. Point Railway's health check here,
  so a new container that can't reach its database never takes traffic during a deploy.

Both are unauthenticated and exempt from rate limiting — the platform's health checker
has no credentials, and at the global 20-requests/60s limit it would otherwise throttle
itself into declaring the service dead.
