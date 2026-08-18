/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Seed the demo accounts Google Play reviewers use.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A CODE BACKDOOR
 *
 * Play reviewers test from outside Pakistan. If they can't get past the login
 * screen the app is rejected for "incomplete app access" — and a driver signup
 * lands on kycStatus PENDING, which shows them nothing but a waiting screen.
 * So they need an account that is already approved.
 *
 * The tempting shortcut is a hardcoded phone/OTP pair in auth.service.ts that
 * skips verification. Do not do that. It is a permanent, unremovable backdoor
 * to a DRIVER account, it lives in the source of a public repo, and anyone who
 * reads it can dispatch themselves real passengers.
 *
 * This instead creates two ordinary accounts with ordinary passwords. They log
 * in through the same code path as everyone else, they can be suspended from
 * the ops dashboard like anyone else, and rotating the credentials is one
 * command rather than a deploy. Give the credentials to Google in Play Console
 * → App access, never in the repo.
 *
 * Usage (password is required, never defaulted):
 *   DEMO_PASSWORD='...' node scripts/seed-demo-accounts.js
 */

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");

const prisma = new PrismaClient();

const PASSWORD = process.env.DEMO_PASSWORD;
const DEMO_RIDER_PHONE = process.env.DEMO_RIDER_PHONE || "+923000000001";
const DEMO_DRIVER_PHONE = process.env.DEMO_DRIVER_PHONE || "+923000000002";

async function upsertDemo({ phone, email, name, role, kycStatus, hash }) {
  const existing = await prisma.user.findUnique({ where: { phone } });

  const data = {
    email,
    name,
    lastName: "Demo",
    passwordHash: hash,
    role,
    kycStatus,
    /* SEGREGATION, not privilege.
       These accounts exist so an App Store or Play reviewer — testing from
       outside Pakistan, at an hour when no real rider is online — can complete
       a whole trip instead of meeting "no riders available" and concluding the
       app is broken. That specific outcome is a common rejection.
       The flag guarantees two things, enforced in LocationService
       .filterEligible: a reviewer's ride is never dispatched to a real person
       on a real bike, and a paying customer is never matched to this fleet.
       It also keeps these trips out of the ledger, settlement and loyalty
       totals, so the books never disagree with reality by however many times
       the app was reviewed. */
    isTestAccount: true,
    isActive: true,
  };

  const user = existing
    ? await prisma.user.update({ where: { phone }, data })
    : await prisma.user.create({ data: { phone, ...data } });

  if (role === "DRIVER") {
    // A reviewer opening the driver app needs a vehicle on file, or they land
    // on the onboarding screen instead of the home screen — which looks
    // exactly like the "can't access the app" they reject for.
    await prisma.driverProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        vehicleType: "bike",
        vehiclePlate: "KHI-0000",
        serviceZone: "Karachi",
        isOnline: false,
      },
      update: { vehicleType: "bike", vehiclePlate: "KHI-0000", isOnline: false },
    });
  }

  return user;
}

async function main() {
  if (!PASSWORD || PASSWORD.length < 8) {
    console.error(
      "\n  Refusing to seed without DEMO_PASSWORD (8+ chars).\n" +
        "  A default password on a pre-approved DRIVER account is a backdoor.\n\n" +
        "  DEMO_PASSWORD='choose-something' node scripts/seed-demo-accounts.js\n",
    );
    process.exit(1);
  }

  const hash = await bcrypt.hash(PASSWORD, 10);

  const rider = await upsertDemo({
    phone: DEMO_RIDER_PHONE,
    email: "demo.customer@novagorides.com",
    name: "Play Review",
    role: "RIDER",
    kycStatus: "APPROVED",
    hash,
  });

  const driver = await upsertDemo({
    phone: DEMO_DRIVER_PHONE,
    email: "demo.driver@novagorides.com",
    name: "Play Review",
    role: "DRIVER",
    // Pre-approved on purpose: this is the whole reason the script exists.
    kycStatus: "APPROVED",
    hash,
  });

  console.log(`
  Demo accounts ready.

    Customer   ${rider.phone}   /  demo.customer@novagorides.com
    Driver     ${driver.phone}  /  demo.driver@novagorides.com   (KYC approved)

  Both use the DEMO_PASSWORD you just passed. Put these in
  Play Console -> App access -> "All or some functionality is restricted",
  one entry per app. Do not commit the password.

  Rotate by re-running this with a new DEMO_PASSWORD.
`);
}

main()
  .catch((err) => {
    console.error("Seeding failed:", err?.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
