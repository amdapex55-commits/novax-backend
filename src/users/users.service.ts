import { BadRequestException, Injectable, NotFoundException, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UpdateVehicleDto } from "./dto/update-vehicle.dto";
import { NotificationsService } from "../notifications/notifications.service";
import { SetModeDto } from "./dto/set-mode.dto";
import { DriverOnboardingDto } from "./dto/driver-onboarding.dto";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  /**
   * Delete this account. Google Play requires it; the shape below is what makes
   * it possible without destroying the books.
   *
   * ANONYMISE, DO NOT DROP. A hard delete is impossible here and pretending
   * otherwise would corrupt real records:
   *   - Ledger entries are financial history. A driver's unsettled commission
   *     and a customer's completed fares have to survive, or the platform's
   *     accounts stop reconciling with the cash actually collected.
   *   - Trips have TWO parties. Deleting a rider would blow away the other
   *     person's trip history and the driver's earnings record with it.
   *   - Incidents are a safety log. An SOS record that can be erased by the
   *     person who caused it is not a safety log.
   *
   * So every direct identifier is destroyed — name, email, address, password,
   * licence and CNIC images, and the phone number is replaced with an
   * unusable placeholder — while the rows those records point at stay intact
   * and become unattributable. That satisfies "delete my data" in the sense
   * that matters: nothing left identifies the person.
   *
   * Deliberately NOT blocked by an outstanding balance. Refusing to delete
   * someone's data because they owe money is not a defensible reading of the
   * policy. The debt survives as an anonymous ledger row for reconciliation,
   * and ops is told before the identifiers go.
   */
  async deleteOwnAccount(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, role: true, name: true },
    });
    if (!user) throw new NotFoundException("Account not found");

    const balance = await this.prisma.ledgerEntry.aggregate({
      where: { userId },
      _sum: { netAmount: true },
    });
    const owed = balance._sum.netAmount ? Number(balance._sum.netAmount) : 0;
    if (owed < 0) {
      // Logged loudly BEFORE the identifiers are gone — afterwards there is no
      // way to work out who this was.
      this.logger.error(
        `Account ${userId} (${user.phone}, ${user.name || "unnamed"}) is being deleted with an outstanding balance of ${owed.toFixed(2)}. ` +
          "The ledger rows survive but are no longer attributable. Reconcile before month end.",
      );
    }

    // Unique columns can't just be nulled — the placeholder has to be unique
    // too, or a second deletion collides on the same value.
    const tombstone = `deleted-${userId}`;

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          phone: tombstone,
          email: null,
          name: "Deleted user",
          lastName: null,
          address: null,
          passwordHash: null,
          referralCode: null,
          // Cannot sign in, cannot be matched, cannot be contacted.
          isActive: false,
        },
      }),
      // Every refresh token, so no live session outlives the deletion.
      this.prisma.refreshToken.deleteMany({ where: { userId } }),
      this.prisma.otpCode.deleteMany({ where: { userId } }),
      // Document images are the most sensitive thing we hold. The URLs go
      // here; the R2 objects themselves are removed by the ops runbook, since
      // this backend deliberately has no delete credentials for that bucket.
      this.prisma.driverProfile.updateMany({
        where: { userId },
        data: {
          cnicNumber: null,
          cnicFrontUrl: null,
          cnicBackUrl: null,
          licenseDocUrl: null,
          licenseFrontUrl: null,
          licenseBackUrl: null,
          vehicleDocUrl: null,
          vehiclePhotoUrl: null,
          payoutAccountName: null,
          payoutAccountNumber: null,
          isOnline: false,
        },
      }),
    ]);

    this.logger.warn(`Account ${userId} anonymised at the user's request (role ${user.role}).`);
    return {
      deleted: true,
      message:
        "Your account has been deleted. Your personal details are gone. " +
        "Anonymous records of completed trips are kept for accounting and safety, as set out in the Privacy Policy.",
    };
  }

  /**
   * Deletion request from the public web form.
   *
   * Google Play requires a deletion route reachable WITHOUT the app installed.
   * That page has no session, so it cannot delete anything — it records a
   * request for ops to verify and action.
   *
   * The response is identical whether or not the contact matches an account.
   * An unauthenticated endpoint that confirms "yes, that number is registered"
   * is a free account-enumeration oracle, and the identifier here is a phone
   * number.
   */
  async requestDeletion(contact: string, note?: string) {
    await this.prisma.deletionRequest.create({
      data: { contact: contact.trim(), note: note?.trim() || null },
    });
    this.logger.warn(`Public deletion request received for "${contact.trim()}" — action within 24h.`);
    return {
      received: true,
      message:
        "Request received. We'll verify it and delete the account within 24 hours. " +
        "If you still have the app, you can delete instantly from Profile → Delete account.",
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        name: true,
        role: true,
        kycStatus: true,
        rating: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException("User not found");
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const email = dto.email?.trim().toLowerCase();

    // email is unique. Spreading the DTO straight into `data` would surface a
    // raw Prisma P2002 as a 500 — the customer sees "something went wrong"
    // for a mistake they could fix in two seconds if we told them what it was.
    if (email) {
      const clash = await this.prisma.user.findFirst({
        where: { email, NOT: { id: userId } },
        select: { id: true },
      });
      if (clash) {
        throw new BadRequestException("That email is already used by another account.");
      }
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.lastName !== undefined ? { lastName: dto.lastName.trim() } : {}),
        ...(email !== undefined ? { email } : {}),
      },
      select: { id: true, phone: true, name: true, lastName: true, email: true, role: true },
    });
  }

  // Admin-only in practice (guard this route with @Roles("ADMIN")) — approve a
  // driver's KYC so they're allowed to go online. Never self-service.
  async approveDriverKyc(userId: string) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: "APPROVED" },
    });
    await this.notificationsService.create(
      userId,
      "You're approved!",
      "Your driver verification is complete — you can go online and start accepting rides.",
    );
    return updated;
  }

  // DriverProfile was defined in the schema but never actually created
  // anywhere — KYC approval could flip a driver's status with zero vehicle
  // data behind it. upsert here so the driver's own Vehicle screen is what
  // actually creates the row, instead of it silently never existing.
  getVehicle(userId: string) {
    return this.prisma.driverProfile.findUnique({ where: { userId } });
  }

  upsertVehicle(userId: string, dto: UpdateVehicleDto) {
    return this.prisma.driverProfile.upsert({
      where: { userId },
      create: { userId, ...dto },
      update: { ...dto },
    });
  }

  // --- Driver onboarding ---
  //
  // Save-as-you-go: a driver collects documents over days, not in one sitting,
  // so every field is individually optional and this is idempotent.
  saveOnboarding(userId: string, dto: DriverOnboardingDto) {
    const { vehicleType, ...rest } = dto;
    return this.prisma.driverProfile.upsert({
      where: { userId },
      create: { userId, vehicleType: vehicleType ?? "bike", ...rest },
      update: { ...(vehicleType ? { vehicleType } : {}), ...rest },
    });
  }

  /** Everything a reviewer needs, plus what's still missing. The driver's own
   * screen uses `missing` to show a checklist instead of a silent Submit. */
  private static REQUIRED_FOR_REVIEW: Array<{ key: string; label: string }> = [
    { key: "vehicleType", label: "Vehicle type" },
    { key: "vehiclePlate", label: "Number plate" },
    { key: "cnicNumber", label: "CNIC number" },
    { key: "cnicFrontUrl", label: "CNIC front photo" },
    { key: "cnicBackUrl", label: "CNIC back photo" },
    { key: "licenseDocUrl", label: "Driving licence" },
    { key: "vehicleDocUrl", label: "Vehicle registration" },
    { key: "serviceZone", label: "Service area" },
    { key: "payoutMethod", label: "Payout method" },
    { key: "payoutAccountNumber", label: "Payout account" },
    { key: "emergencyContactPhone", label: "Emergency contact" },
  ];

  async getOnboardingStatus(userId: string) {
    const [user, profile] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { kycStatus: true, name: true, phone: true } }),
      this.prisma.driverProfile.findUnique({ where: { userId } }),
    ]);
    if (!user) throw new NotFoundException("User not found");

    const missing = UsersService.REQUIRED_FOR_REVIEW.filter(
      (f) => !profile || !(profile as any)[f.key],
    ).map((f) => f.label);
    if (!user.name) missing.unshift("Your full name");

    return {
      kycStatus: user.kycStatus,
      submittedForReviewAt: profile?.submittedForReviewAt ?? null,
      trainingCompleted: profile?.trainingCompleted ?? false,
      profile,
      missing,
      canSubmit: missing.length === 0,
    };
  }

  /** Driver says "I'm done" — stamps the queue time an admin sorts by.
   * Refuses if the file is incomplete, so ops never opens a half-empty
   * application and has to chase the driver for the rest. */
  async submitForReview(userId: string) {
    const status = await this.getOnboardingStatus(userId);
    if (!status.canSubmit) {
      throw new BadRequestException(`Still missing: ${status.missing.join(", ")}`);
    }
    if (status.kycStatus === "APPROVED") {
      throw new BadRequestException("You're already approved");
    }
    const updated = await this.prisma.driverProfile.update({
      where: { userId },
      data: { submittedForReviewAt: new Date() },
    });
    await this.notificationsService.create(
      userId,
      "Application submitted",
      "Thanks — our team is reviewing your documents. We'll notify you as soon as you're approved.",
    );
    return updated;
  }

  /** Admin-only: internal notes + training checkbox. Kept apart from
   * saveOnboarding so a driver can never write these about themselves. */
  adminReviewDriver(driverUserId: string, dto: { onboardingNotes?: string; trainingCompleted?: boolean }) {
    return this.prisma.driverProfile.update({
      where: { userId: driverUserId },
      data: {
        ...(dto.onboardingNotes !== undefined ? { onboardingNotes: dto.onboardingNotes } : {}),
        ...(dto.trainingCompleted !== undefined ? { trainingCompleted: dto.trainingCompleted } : {}),
      },
    });
  }

  /** Full application for the ops review screen. */
  async getDriverApplication(driverUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: driverUserId },
      select: {
        id: true, name: true, phone: true, role: true, kycStatus: true, rating: true,
        isActive: true, createdAt: true, driverProfile: true,
      },
    });
    if (!user) throw new NotFoundException("Driver not found");
    return user;
  }

  /** Rejecting matters as much as approving — a driver stuck on "pending"
   * forever with no reason is how you lose supply. */
  async rejectDriverKyc(userId: string, reason: string) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: "REJECTED" },
    });
    await this.notificationsService.create(
      userId,
      "Application needs attention",
      reason || "Some of your documents couldn't be verified. Please re-upload them and submit again.",
    );
    return updated;
  }

  // Dual-mode toggle — a driver only ever sits in one matching queue at a
  // time (see the DriverProfile.activeMode schema comment). One tap in the
  // app between "Ride" and "Food & Errands".
  //
  // Blocked while a job is in flight: nothing in trips/delivery/food-orders/
  // errands services checks activeMode once a driver is already assigned —
  // matching only reads it at offer time. Without this guard a driver mid-
  // delivery could flip queues and immediately start receiving offers from
  // the *other* queue while still supposed to be, say, driving a passenger,
  // or could dodge a pending offer/negotiation by switching away instead of
  // explicitly declining it. Checked against the same statuses each
  // service's own assertDriverOwns*() methods treat as "in progress".
  async setActiveMode(userId: string, dto: SetModeDto) {
    const [activeTrip, activeDelivery, activeFoodOrder, activeErrand] = await Promise.all([
      this.prisma.trip.count({ where: { driverId: userId, status: { in: ["MATCHING", "MATCHED", "IN_PROGRESS"] } } }),
      this.prisma.delivery.count({ where: { driverId: userId, status: { in: ["MATCHING", "MATCHED", "PICKED_UP", "IN_TRANSIT"] } } }),
      this.prisma.foodOrder.count({ where: { driverId: userId, status: { in: ["MATCHING", "ASSIGNED", "PICKED_UP"] } } }),
      this.prisma.errand.count({ where: { driverId: userId, status: { in: ["MATCHING", "ACCEPTED", "SHOPPING", "ON_THE_WAY"] } } }),
    ]);
    if (activeTrip + activeDelivery + activeFoodOrder + activeErrand > 0) {
      throw new BadRequestException("Finish or cancel your current job before switching queues");
    }

    return this.prisma.driverProfile.upsert({
      where: { userId },
      create: { userId, vehicleType: "bike", activeMode: dto.mode },
      update: { activeMode: dto.mode },
    });
  }
}
