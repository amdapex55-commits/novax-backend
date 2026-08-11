/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Apply migrations at boot, baselining an existing database on the way if it
 * needs it.
 *
 * THE PROBLEM THIS SOLVES
 *
 * This project ran `prisma db push` for its whole life, which creates tables
 * without recording anything in `_prisma_migrations`. Switching to
 * `prisma migrate deploy` therefore meets a database full of tables that
 * Prisma has no record of creating, and it refuses to touch it:
 *
 *   Error: P3005 — The database schema is not empty.
 *
 * The documented fix is a one-off `prisma migrate resolve --applied 0_init`
 * run by hand against production. That works exactly once, from a laptop that
 * happens to have the production credentials, and is forgotten by the time
 * anyone creates a staging environment — at which point the same crash
 * happens again to someone with less context.
 *
 * So the baseline is done here instead: idempotent, credential-free, and
 * correct for all three cases.
 *
 *   1. Brand-new empty database  -> no baseline, apply every migration.
 *   2. Existing db-push database -> mark 0_init as already applied, then
 *                                   apply only what came after it.
 *   3. Already-migrated database -> nothing to do, migrate deploy no-ops.
 *
 * What it deliberately does NOT do: create, drop or alter anything itself.
 * Baselining writes one row to `_prisma_migrations` and runs none of 0_init's
 * SQL, so the tables your live riders' data sits in are never touched.
 */

const { execSync } = require("child_process");

const BASELINE_MIGRATION = "0_init";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

async function inspectDatabase() {
  // Required lazily: if the client isn't generated the error should say that,
  // rather than failing at import time with something less obvious.
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();

  try {
    const rows = await prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE table_name = '_prisma_migrations') AS migrations_table,
        COUNT(*) FILTER (WHERE table_name <> '_prisma_migrations') AS other_tables
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    // COUNT() comes back as BigInt over the wire; Number() before comparing.
    const row = rows[0] || {};
    return {
      hasMigrationsTable: Number(row.migrations_table ?? 0) > 0,
      hasExistingTables: Number(row.other_tables ?? 0) > 0,
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("[NovaGo] DATABASE_URL is not set — cannot run migrations.");
    process.exit(1);
  }

  const { hasMigrationsTable, hasExistingTables } = await inspectDatabase();

  if (!hasMigrationsTable && hasExistingTables) {
    console.log(
      `[NovaGo] Existing schema with no migration history — baselining "${BASELINE_MIGRATION}".\n` +
        "[NovaGo] This records it as already applied. No SQL from it is executed.",
    );
    run(`npx prisma migrate resolve --applied ${BASELINE_MIGRATION}`);
  } else if (!hasExistingTables) {
    console.log("[NovaGo] Empty database — applying all migrations from scratch.");
  } else {
    console.log("[NovaGo] Migration history present — applying anything outstanding.");
  }

  run("npx prisma migrate deploy");
}

main().catch((err) => {
  console.error("[NovaGo] Migration step failed:", err?.message || err);
  process.exit(1);
});
