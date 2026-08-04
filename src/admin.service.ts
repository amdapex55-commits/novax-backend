import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { TripStatus, DeliveryStatus } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { NotificationsService } from "./notifications.service";
import { LocationGateway } from "./location.gateway";

// Typed against the real Prisma enums, not plain strings — a bare
// string[] literal doesn't satisfy Prisma's `status: { in: TripStatus[] }`
// filter type, which is exactly what broke the build.
const ACTIVE_TRIP_STATUSES: TripStatus[] = ["MATCHING", "MATCHED", "IN_PROGRESS"];
const ACTIVE_DELIVERY_STATUSES: DeliveryStatus[] = ["MATCHING", "MATCHED", "PICKED_UP", "IN_TRANSIT"];

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
    private locationGateway: LocationGateway,
  ) {}

  async getStats() {
    const [activeTrips, activeDeliveries, onlineDrivers, pendingKyc, totalUsers, totalDrivers] = await Promise.all([
      this.prisma.trip.count({ where: { status: { in: ACTIVE_TRIP_STATUSES } } }),
      this.prisma.delivery.count({ where: { status: { in: ACTIVE_DELIVERY_STATUSES } } }),
      this.prisma.driverProfile.count({ where: { isOnline: true } }),
      this.prisma.user.count({ where: { role: "DRIVER", kycStatus: "PENDING" } }),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: "DRIVER" } }),
    ]);
    return { activeTrips, activeDeliveries, onlineDrivers, pendingKyc, totalUsers, totalDrivers };
  }

  listPendingDrivers() {
    return this.prisma.user.findMany({
      where: { role: "DRIVER", kycStatus: "PENDING" },
      select: {
        id: true,
        phone: true,
        name: true,
        createdAt: true,
        driverProfile: { select: { vehicleType: true, vehiclePlate: true, cnicNumber: true, licenseDocUrl: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
  }

  listUsers() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        phone: true,
        name: true,
        role: true,
        kycStatus: true,
        rating: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  /**
   * DISPATCH FALLBACK — the single most important ops screen.
   *
   * Automatic matching fails in ordinary ways: nobody online in that area,
   * everyone declined, a driver accepted then vanished. When it does, the
   * customer is sitting there watching a spinner and NOBODY KNOWS. This
   * surfaces those jobs so a human can call a driver and assign them by hand.
   *
   * "Stuck" = still unassigned (or unaccepted) past a grace period. The
   * threshold is minutes, not hours, because a rider gives up long before an
   * hour passes.
   */
  async listStuckJobs(minutesStuck = 3) {
    const cutoff = new Date(Date.now() - minutesStuck * 60_000);

    const [trips, deliveries, foodOrders, errands] = await Promise.all([
      this.prisma.trip.findMany({
        where: { status: { in: ["REQUESTED", "MATCHING"] }, requestedAt: { lt: cutoff } },
        select: {
          id: true, status: true, vehicleType: true, requestedAt: true, fare: true,
          pickupLat: true, pickupLng: true, dropoffLat: true, dropoffLng: true,
          rider: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { requestedAt: "asc" },
        take: 50,
      }),
      this.prisma.delivery.findMany({
        where: { status: { in: ["REQUESTED", "MATCHING"] }, requestedAt: { lt: cutoff } },
        select: {
          id: true, status: true, requestedAt: true, fare: true,
          pickupLat: true, pickupLng: true, recipientName: true, recipientPhone: true,
          sender: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { requestedAt: "asc" },
        take: 50,
      }),
      this.prisma.foodOrder.findMany({
        // PLACED = restaurant hasn't even accepted (call the kitchen);
        // READY/MATCHING = food is going cold waiting for a rider.
        where: { status: { in: ["PLACED", "READY", "MATCHING"] }, placedAt: { lt: cutoff } },
        select: {
          id: true, status: true, placedAt: true, total: true, dropoffLabel: true,
          customer: { select: { id: true, name: true, phone: true } },
          restaurant: { select: { id: true, name: true, notifyPhone: true, lat: true, lng: true } },
        },
        orderBy: { placedAt: "asc" },
        take: 50,
      }),
      this.prisma.errand.findMany({
        where: { status: { in: ["REQUESTED", "MATCHING"] }, requestedAt: { lt: cutoff } },
        select: {
          id: true, status: true, requestedAt: true, storeLabel: true, dropoffLabel: true,
          requester: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { requestedAt: "asc" },
        take: 50,
      }),
    ]);

    const minutesAgo = (d: Date) => Math.floor((Date.now() - d.getTime()) / 60_000);
    return {
      thresholdMinutes: minutesStuck,
      total: trips.length + deliveries.length + foodOrders.length + errands.length,
      trips: trips.map((t) => ({ ...t, fare: t.fare ? Number(t.fare) : null, waitingMinutes: minutesAgo(t.requestedAt) })),
      deliveries: deliveries.map((d) => ({ ...d, fare: d.fare ? Number(d.fare) : null, waitingMinutes: minutesAgo(d.requestedAt) })),
      foodOrders: foodOrders.map((o) => ({ ...o, total: Number(o.total), waitingMinutes: minutesAgo(o.placedAt) })),
      errands: errands.map((e) => ({ ...e, waitingMinutes: minutesAgo(e.requestedAt) })),
    };
  }

  /** Drivers ops can actually phone right now, nearest-first is not possible
   * without a reference point, so this is "who is online at all" — the list a
   * dispatcher works down when auto-matching has already failed. */
  async listAvailableDrivers() {
    const profiles = await this.prisma.driverProfile.findMany({
      where: { isOnline: true },
      select: {
        userId: true, vehicleType: true, vehiclePlate: true, activeMode: true, serviceZone: true,
        user: { select: { id: true, name: true, phone: true, rating: true, kycStatus: true, isActive: true } },
      },
      take: 100,
    });
    // Only genuinely dispatchable people — same gate as the socket connect.
    return profiles.filter((p) => p.user.kycStatus === "APPROVED" && p.user.isActive);
  }

  /**
   * Manual assignment. Bypasses the offer/countdown dance entirely and puts
   * the driver straight on the job, because by the time ops is doing this
   * they've already phoned the driver and gotten a yes out loud.
   *
   * Conditional update (same pattern as the payout guards): only assigns if
   * the job is genuinely still unassigned, so a dispatcher can't stomp a
   * match that landed a second earlier.
   */
  async manuallyAssign(jobType: "TRIP" | "DELIVERY" | "FOOD_ORDER" | "ERRAND", jobId: string, driverId: string) {
    const driver = await this.prisma.user.findUnique({
      where: { id: driverId },
      select: { role: true, kycStatus: true, isActive: true },
    });
    if (!driver || driver.role !== "DRIVER") throw new NotFoundException("Driver not found");
    if (driver.kycStatus !== "APPROVED" || !driver.isActive) {
      throw new BadRequestException("That driver isn't approved/active — can't assign a real job to them");
    }

    const now = new Date();
    switch (jobType) {
      case "TRIP": {
        const r = await this.prisma.trip.updateMany({
          where: { id: jobId, status: { in: ["REQUESTED", "MATCHING"] } },
          data: { driverId, status: "MATCHED", matchedAt: now },
        });
        if (r.count === 0) throw new BadRequestException("This trip is no longer awaiting a driver");
        break;
      }
      case "DELIVERY": {
        const r = await this.prisma.delivery.updateMany({
          where: { id: jobId, status: { in: ["REQUESTED", "MATCHING"] } },
          data: { driverId, status: "MATCHED", matchedAt: now },
        });
        if (r.count === 0) throw new BadRequestException("This delivery is no longer awaiting a driver");
        break;
      }
      case "FOOD_ORDER": {
        const r = await this.prisma.foodOrder.updateMany({
          where: { id: jobId, status: { in: ["READY", "MATCHING"] } },
          data: { driverId, status: "ASSIGNED" },
        });
        if (r.count === 0) throw new BadRequestException("This order is not ready/awaiting a rider");
        break;
      }
      case "ERRAND": {
        const r = await this.prisma.errand.updateMany({
          where: { id: jobId, status: { in: ["REQUESTED", "MATCHING"] } },
          data: { driverId, status: "ACCEPTED", acceptedAt: now },
        });
        if (r.count === 0) throw new BadRequestException("This errand is no longer awaiting a driver");
        break;
      }
    }

    await this.notificationsService.create(
      driverId,
      "Job assigned to you",
      "Nova X ops assigned you a job directly — open the app to see it.",
    );
    this.locationGateway.emitToUser(driverId, "job:manuallyAssigned", { jobType, jobId });

    this.logger.warn(`Ops manually assigned ${jobType} ${jobId} to driver ${driverId}`);
    return { ok: true, jobType, jobId, driverId };
  }
}
