import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { UpdateProfileDto } from "./update-profile.dto";
import { UpdateVehicleDto } from "./update-vehicle.dto";
import { NotificationsService } from "./notifications.service";
import { SetModeDto } from "./set-mode.dto";
import { DriverOnboardingDto } from "./driver-onboarding.dto";

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

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
    return this.prisma.user.update({
      where: { id: userId },
      data: dto,
      select: { id: true, phone: true, name: true, role: true },
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
