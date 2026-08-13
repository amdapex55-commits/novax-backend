/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Grant (or create) an ADMIN account.
 *
 * WHY THIS HAD TO BE WRITTEN
 *
 * Nothing in this codebase could produce an ADMIN. The role is defined in the
 * schema, enforced by RolesGuard on every /admin endpoint, and checked by the
 * router before it will render the ops console — but no seed, no endpoint, no
 * env var and no documented step ever set it on a row. Every path that could
 * has a guard in front of it that only an existing admin passes.
 *
 * That is not a cosmetic gap. Driver approval is ADMIN-only, and a driver
 * cannot go online until kycStatus is APPROVED. With no admin in existence,
 * no driver can ever be approved, so no driver can ever receive a job, so the
 * platform cannot complete a single trip. The ops desk — approvals, live
 * dispatch, settlement, the growth desk — was unreachable for the same reason.
 *
 * WHY IT IS A SCRIPT AND NOT AN ENDPOINT
 *
 * A "promote me to admin" endpoint is a privilege-escalation hole no matter
 * how it is guarded, and a FIRST_ADMIN_EMAIL env var quietly re-grants the
 * role on every boot — so anyone who ever reads that variable has a permanent
 * way back in. This runs deliberately, by a human with database access, and
 * leaves no standing mechanism behind.
 *
 * USAGE — run it where DATABASE_URL already points at production, so the
 * credential never has to be copied anywhere:
 *
 *   railway run node scripts/make-admin.js ops@yourdomain.com
 *
 * Promoting an existing account (recommended — sign up in the app first):
 *   railway run node scripts/make-admin.js ops@yourdomain.com
 *
 * Creating one outright (password required, never defaulted):
 *   ADMIN_PASSWORD='...' railway run node scripts/make-admin.js ops@yourdomain.com +923001234567
 *
 * To revoke later:
 *   railway run node scripts/make-admin.js --revoke ops@yourdomain.com
 */

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const revoke = args.includes("--revoke");
const positional = args.filter((a) => !a.startsWith("--"));
const identifier = positional[0];
const newPhone = positional[1];
const PASSWORD = process.env.ADMIN_PASSWORD;

function bail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

/** Accepts an email or a phone in any of the shapes people actually type. */
function normalisePhone(raw) {
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  // 03001234567 -> +923001234567; 923001234567 -> +923001234567
  if (digits.startsWith("0")) return "+92" + digits.slice(1);
  if (digits.startsWith("92")) return "+" + digits;
  return "+" + digits;
}

async function findUser(id) {
  if (id.includes("@")) return prisma.user.findUnique({ where: { email: id } });
  const phone = normalisePhone(id);
  return phone ? prisma.user.findUnique({ where: { phone } }) : null;
}

async function main() {
  if (!identifier) {
    bail(
      "Usage: node scripts/make-admin.js <email|phone> [phone-if-creating]\n" +
      "         node scripts/make-admin.js --revoke <email|phone>",
    );
  }

  const existing = await findUser(identifier);

  /* ---------------------------------------------------------- revoke --- */
  if (revoke) {
    if (!existing) bail(`No account found for "${identifier}".`);
    if (existing.role !== "ADMIN") {
      console.log(`\n  ${identifier} is already ${existing.role}, not ADMIN. Nothing to do.\n`);
      return;
    }
    // Refuse to remove the last admin — that locks everyone out of ops with
    // no way back except running this script again, which is exactly the
    // situation it was written to fix.
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      bail(
        `Refusing: ${identifier} is the ONLY admin.\n` +
        "  Promote a second account first, then revoke this one.",
      );
    }
    await prisma.user.update({ where: { id: existing.id }, data: { role: "RIDER" } });
    console.log(`\n  Revoked. ${identifier} is now RIDER. ${adminCount - 1} admin(s) remain.\n`);
    return;
  }

  /* --------------------------------------------------------- promote --- */
  if (existing) {
    if (existing.role === "ADMIN") {
      console.log(`\n  ${identifier} is already an ADMIN. Nothing to do.\n`);
      return;
    }
    // A DRIVER promoted to ADMIN keeps a DriverProfile and would be matchable
    // as supply while also approving themselves. Say so rather than silently
    // creating that.
    if (existing.role === "DRIVER") {
      bail(
        `${identifier} is a DRIVER. Promoting it would leave one account able to\n` +
        "  approve itself and take jobs. Use a separate account for ops.",
      );
    }
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: { role: "ADMIN", kycStatus: "APPROVED", isActive: true },
    });
    console.log(`
  Promoted to ADMIN

    name   : ${updated.name || "(unset)"} ${updated.lastName || ""}
    email  : ${updated.email || "(unset)"}
    phone  : ${updated.phone}
    role   : ${existing.role} -> ADMIN

  Sign in at ops.html with this account's existing password.
`);
    return;
  }

  /* ---------------------------------------------------------- create --- */
  if (!PASSWORD) {
    bail(
      `No account exists for "${identifier}".\n\n` +
      "  To CREATE one, supply a password and a phone number:\n" +
      `    ADMIN_PASSWORD='...' node scripts/make-admin.js ${identifier} +923001234567\n\n` +
      "  Or sign up in the app first, then re-run this to promote it.",
    );
  }
  if (PASSWORD.length < 12) {
    // Longer than the app's 8-character floor: this account can suspend users,
    // settle money and approve drivers.
    bail("ADMIN_PASSWORD must be at least 12 characters — this account can settle money.");
  }
  if (!identifier.includes("@")) bail("When creating, the first argument must be the email.");
  const phone = normalisePhone(newPhone || "");
  if (!phone) bail("When creating, pass a phone number as the second argument.");

  const clash = await prisma.user.findUnique({ where: { phone } });
  if (clash) bail(`That phone already belongs to ${clash.email || clash.id} (${clash.role}).`);

  const created = await prisma.user.create({
    data: {
      email: identifier,
      phone,
      name: "Ops",
      lastName: "Desk",
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      role: "ADMIN",
      kycStatus: "APPROVED",
      isActive: true,
    },
  });
  console.log(`
  Created ADMIN

    email  : ${created.email}
    phone  : ${created.phone}

  Sign in at ops.html with the password you just supplied.
  It is not stored anywhere else — put it in your password manager now.
`);
}

main()
  .catch((e) => {
    console.error("\n  Failed:", e.message, "\n");
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
