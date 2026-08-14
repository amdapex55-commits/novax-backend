import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { TripStatus, DeliveryStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { LocationGateway } from "../location/location.gateway";
import { LocationService } from "../location/location.service";
import { DRIVER_CREDIT_LIMIT_PKR } from "../location/location.service";

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
    private locationService: LocationService,
  ) {}

  /**
   * Every driver who owes the platform money, worst first.
   *
   * This is the ops side of the credit limit. Matching stops offering work to
   * a driver past DRIVER_CREDIT_LIMIT_PKR, and until there's a payment gateway
   * webhook, the ONLY way back is a human recording that the driver paid —
   * which needs a screen showing who's blocked and how much clears them.
   * Without it the cap is a trap: it stops drivers earning and offers no exit.
   */
  async listDriverBalances() {
    const drivers = await this.prisma.user.findMany({
      where: { role: "DRIVER" },
      select: { id: true, name: true, phone: true, isActive: true, kycStatus: true },
      take: 500,
    });
    if (drivers.length === 0) return [];

    const ids = drivers.map((d) => d.id);
    const sums = await this.prisma.ledgerEntry.groupBy({
      by: ["userId"],
      where: { userId: { in: ids } },
      _sum: { netAmount: true },
    });
    const balanceById = new Map(
      sums.map((s) => [s.userId, s._sum.netAmount ? Number(s._sum.netAmount) : 0]),
    );

    return drivers
      .map((d) => {
        const balance = balanceById.get(d.id) ?? 0;
        return {
          ...d,
          balance,
          blocked: DRIVER_CREDIT_LIMIT_PKR !== 0 && balance <= -DRIVER_CREDIT_LIMIT_PKR,
          creditLimit: DRIVER_CREDIT_LIMIT_PKR === 0 ? null : -DRIVER_CREDIT_LIMIT_PKR,
          // What ops should collect to bring them back to zero.
          amountToSettle: balance < 0 ? Math.abs(balance) : 0,
        };
      })
      // Most indebted first — that's the call list, in order.
      .sort((a, b) => a.balance - b.balance);
  }

  /**
   * Growth surface: business leads, referrals and loyalty in one place.
   *
   * All three were being captured and none were readable. A B2B lead form
   * that files into a table nobody opens is worse than no form — someone
   * asked to be contacted and won't be.
   */
  async getGrowth() {
    const [leads, topReferrers, loyaltyAgg, referredCount] = await Promise.all([
      this.prisma.businessLead.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      // Who is actually bringing people in — the only referral number that
      // changes what you'd do (thank them, or ask them what's working).
      this.prisma.user.findMany({
        where: { referrals: { some: {} } },
        select: {
          id: true,
          name: true,
          lastName: true,
          phone: true,
          referralCode: true,
          loyaltyPoints: true,
          _count: { select: { referrals: true } },
        },
        orderBy: { referrals: { _count: "desc" } },
        take: 20,
      }),
      this.prisma.user.aggregate({ _sum: { loyaltyPoints: true } }),
      this.prisma.user.count({ where: { referredById: { not: null } } }),
    ]);

    return {
      businessLeads: leads,
      newLeadsCount: leads.filter((l) => l.status === "NEW" || !l.status).length,
      topReferrers: topReferrers.map((u) => ({
        id: u.id,
        name: [u.name, u.lastName].filter(Boolean).join(" ") || u.phone,
        phone: u.phone,
        referralCode: u.referralCode,
        loyaltyPoints: u.loyaltyPoints,
        referredCount: u._count.referrals,
      })),
      totalLoyaltyPointsIssued: loyaltyAgg._sum.loyaltyPoints ?? 0,
      signupsFromReferral: referredCount,
    };
  }

  /** Mark a B2B lead as contacted or closed. */
  async setLeadStatus(leadId: string, status: "NEW" | "CONTACTED" | "CLOSED") {
    const lead = await this.prisma.businessLead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException("Lead not found");
    return this.prisma.businessLead.update({
      where: { id: leadId },
      data: { status, handledAt: status === "NEW" ? null : new Date() },
    });
  }

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
   * Suspend / reactivate any account.
   *
   * `isActive` was being READ in four places (matching, socket connect,
   * manual assign) but nothing could ever WRITE it — so a driver who
   * behaved badly could not actually be stopped. This is the write side.
   *
   * Suspending a driver also forces them offline immediately, otherwise
   * they'd stay in the matching pool until their socket happened to drop.
   */
  async setUserActive(userId: string, isActive: boolean, reason?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user) throw new NotFoundException("User not found");

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { isActive },
      select: { id: true, name: true, phone: true, role: true, isActive: true },
    });

    if (!isActive && user.role === "DRIVER") {
      await this.prisma.driverProfile
        .update({ where: { userId }, data: { isOnline: false } })
        .catch(() => {}); // no profile yet — nothing to flip
      this.locationGateway.emitToUser(userId, "account:suspended", {
        message: reason || "Your account has been suspended. Contact support.",
      });
    }

    await this.notificationsService.create(
      userId,
      isActive ? "Account reactivated" : "Account suspended",
      isActive
        ? "Your Nova Go account is active again."
        : reason || "Your account has been suspended. Please contact support.",
    );

    this.logger.warn(`Ops ${isActive ? "reactivated" : "SUSPENDED"} user ${userId} (${user.role})`);
    return updated;
  }

  /** Everyone online right now — the "who's actually working" view. */
  async listLiveDrivers() {
    const profiles = await this.prisma.driverProfile.findMany({
      where: { isOnline: true },
      select: {
        userId: true, vehicleType: true, vehiclePlate: true, activeMode: true, serviceZone: true,
        user: { select: { id: true, name: true, phone: true, rating: true, kycStatus: true, isActive: true } },
      },
      take: 200,
    });

    // What each of them is currently doing — an online driver with no job is
    // idle supply, an online driver mid-trip is busy. Ops needs the difference.
    const ids = profiles.map((p) => p.userId);
    const [trips, deliveries, orders, errands] = await Promise.all([
      this.prisma.trip.findMany({ where: { driverId: { in: ids }, status: { in: ["MATCHING", "MATCHED", "IN_PROGRESS"] } }, select: { driverId: true, status: true } }),
      this.prisma.delivery.findMany({ where: { driverId: { in: ids }, status: { in: ["MATCHING", "MATCHED", "PICKED_UP", "IN_TRANSIT"] } }, select: { driverId: true, status: true } }),
      this.prisma.foodOrder.findMany({ where: { driverId: { in: ids }, status: { in: ["MATCHING", "ASSIGNED", "PICKED_UP"] } }, select: { driverId: true, status: true } }),
      this.prisma.errand.findMany({ where: { driverId: { in: ids }, status: { in: ["MATCHING", "ACCEPTED", "SHOPPING", "ON_THE_WAY"] } }, select: { driverId: true, status: true } }),
    ]);
    const busy = new Map<string, string>();
    for (const t of trips) if (t.driverId) busy.set(t.driverId, `Ride · ${t.status}`);
    for (const d of deliveries) if (d.driverId) busy.set(d.driverId, `Parcel · ${d.status}`);
    for (const o of orders) if (o.driverId) busy.set(o.driverId, `Food · ${o.status}`);
    for (const e of errands) if (e.driverId) busy.set(e.driverId, `Errand · ${e.status}`);

    // Where each of them actually is. Without this the ops fleet map has a
    // driver list and nothing to plot — the list was previously returned
    // with no coordinates at all, so the map could only ever be empty.
    // One GEOPOS call for the whole fleet, not one per driver.
    // ...and how old each of those positions is. A coordinate with no age is
    // a coordinate ops will trust unconditionally, including the one belonging
    // to a phone that died at a junction twenty minutes ago.
    const [positions, lastFixes] = await Promise.all([
      this.locationService.getDriverLocations(ids),
      this.locationService.getLastFixTimes(ids),
    ]);
    const now = Date.now();

    return profiles.map((p) => {
      const pos = positions.get(p.userId) || null;
      const lastFixAt = lastFixes.get(p.userId) ?? null;
      return {
        ...p,
        currentJob: busy.get(p.userId) || null,
        idle: !busy.has(p.userId),
        // Flattened onto the row because that's the shape the map consumes,
        // and null is meaningful: online but hasn't sent a location ping yet.
        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,
        lastFixAt: lastFixAt ? new Date(lastFixAt).toISOString() : null,
        // Precomputed so the browser doesn't have to trust its own clock —
        // an ops laptop with a skewed clock would otherwise mark the whole
        // fleet stale, or none of it.
        fixAgeSeconds: lastFixAt === null ? null : Math.max(0, Math.round((now - lastFixAt) / 1000)),
      };
    });
  }

  /** Recent cancellations — a spike here is the earliest signal something is
   * wrong (bad ETAs, no supply, a driver gaming the system). */
  async listCancellations(hours = 24) {
    const since = new Date(Date.now() - hours * 3600_000);
    const [trips, orders, deliveries] = await Promise.all([
      this.prisma.trip.findMany({
        where: { status: "CANCELLED", cancelledAt: { gte: since } },
        select: { id: true, cancelledAt: true, vehicleType: true, fare: true, rider: { select: { name: true, phone: true } }, driver: { select: { name: true } } },
        orderBy: { cancelledAt: "desc" }, take: 50,
      }),
      this.prisma.foodOrder.findMany({
        where: { status: "CANCELLED", cancelledAt: { gte: since } },
        select: { id: true, cancelledAt: true, total: true, customer: { select: { name: true, phone: true } }, restaurant: { select: { name: true } } },
        orderBy: { cancelledAt: "desc" }, take: 50,
      }),
      this.prisma.delivery.findMany({
        where: { status: "CANCELLED", cancelledAt: { gte: since } },
        select: { id: true, cancelledAt: true, fare: true, sender: { select: { name: true, phone: true } } },
        orderBy: { cancelledAt: "desc" }, take: 50,
      }),
    ]);
    return {
      windowHours: hours,
      total: trips.length + orders.length + deliveries.length,
      trips: trips.map((t) => ({ ...t, fare: t.fare ? Number(t.fare) : null })),
      foodOrders: orders.map((o) => ({ ...o, total: Number(o.total) })),
      deliveries: deliveries.map((d) => ({ ...d, fare: d.fare ? Number(d.fare) : null })),
    };
  }

  /** Who the platform owes money to (or who owes the platform). Cash-only
   * means this is a settlement worklist, not a payments dashboard. */
  async listBalances() {
    const sums = await this.prisma.ledgerEntry.groupBy({
      by: ["userId"],
      _sum: { netAmount: true },
    });
    const ids = sums.map((s) => s.userId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, phone: true, role: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return sums
      .map((s) => ({
        user: byId.get(s.userId) || { id: s.userId },
        balance: s._sum.netAmount ? Number(s._sum.netAmount) : 0,
      }))
      .filter((r) => r.balance !== 0)
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
      .slice(0, 100);
  }

  /** Support tickets, newest first, with who raised them. */
  listTickets(status?: string) {
    return this.prisma.supportTicket.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { user: { select: { id: true, name: true, phone: true, role: true } } },
    });
  }

  async resolveTicket(ticketId: string) {
    const t = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!t) throw new NotFoundException("Ticket not found");
    const updated = await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status: "RESOLVED" },
    });
    await this.notificationsService.create(
      t.userId,
      "Support ticket resolved",
      `We've looked into "${t.subject}". Reply to the ticket if it's still not sorted.`,
    );
    return updated;
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
          // WHY THE JOB IS STUCK, not just that it is. A dispatcher opening
          // this list has to decide who to phone first, and these are the
          // three facts that decide it:
          //   offerCount 0 + noDriverFoundAt  -> nobody is online near the
          //     pickup. Phoning drivers will not help; this is a coverage
          //     problem and the customer should probably be told.
          //   offerCount high                 -> drivers are being offered and
          //     declining. The job is the problem (bad pickup pin, long dead
          //     leg), and reading it aloud to a driver usually places it.
          //   opsEscalatedAt set              -> past the hard threshold. The
          //     customer has already been told a person has it, so somebody
          //     needs to actually be that person.
          offerCount: true,
          noDriverFoundAt: true,
          opsAlertedAt: true,
          opsEscalatedAt: true,
          pickupLabel: true,
          dropoffLabel: true,
          rider: { select: { id: true, name: true, phone: true } },
        },
        // Escalated first — those are the ones where a promise has already
        // been made to the customer. Oldest first within that.
        orderBy: [{ opsEscalatedAt: { sort: "desc", nulls: "last" } }, { requestedAt: "asc" }],
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
      "Nova Go ops assigned you a job directly — open the app to see it.",
    );
    this.locationGateway.emitToUser(driverId, "job:manuallyAssigned", { jobType, jobId });

    this.logger.warn(`Ops manually assigned ${jobType} ${jobId} to driver ${driverId}`);
    return { ok: true, jobType, jobId, driverId };
  }
}
