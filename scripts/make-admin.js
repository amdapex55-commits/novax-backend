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
const allowWeak = args.includes("--allow-weak-password");
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

  /* ---------------------------------------------------- weak password ---

     The 12-character floor below only applies when this script CREATES the
     account. Promoting one that signed up through the app skips it entirely,
     which makes promotion the path of least resistance and the one most
     likely to be used — so the check has to live here too.

     The stored value is a bcrypt hash and cannot be read back, so this
     compares against the handful of passwords that actually appear at the top
     of every credential-stuffing list. It is not a strength meter; it is a
     check for "this is one of the first things anyone would try", against an
     account that approves drivers carrying passengers, suspends users and
     settles money, on a console reachable from the public internet.

     A warning with an explicit override rather than a refusal: it is the
     operator's system and their call. But it should not be possible to do it
     without having been told.                                              */
  async function usesCommonPassword(user) {
    if (!user.passwordHash) return false;
    const COMMON = [
      "11223344", "12345678", "123456789", "1234567890", "12345678910",
      "password", "password1", "password123", "qwerty123", "abc12345",
      "11111111", "00000000", "87654321", "iloveyou", "admin123",
      "adminadmin", "welcome1", "letmein1", "pakistan", "novago123",
    ];
    for (const guess of COMMON) {
      if (await bcrypt.compare(guess, user.passwordHash)) return guess;
    }
    return false;
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
    const weak = await usesCommonPassword(existing);
    if (weak && !allowWeak) {
      bail(
        `Refusing: this account's password is "${weak}", which is on every\n` +
        "  credential-stuffing list. ops.html is reachable from the public\n" +
        "  internet, and this role approves drivers, suspends users and settles\n" +
        "  money.\n\n" +
        "  Change the password first (sign in and use Profile), then re-run.\n" +
        "  To proceed anyway, knowing the risk:\n" +
        `    node scripts/make-admin.js ${identifier} --allow-weak-password`,
      );
    }
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: { role: "ADMIN", kycStatus: "APPROVED", isActive: true },
    });
    if (weak) {
      console.log(`\n  WARNING: promoted with a known-weak password ("${weak}"). Change it soon.`);
    }
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
