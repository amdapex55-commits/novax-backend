import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Logger } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { LocationService } from "./location.service";
import { LocationGateway } from "./location.gateway";
import { ExcludedDriversStore } from "./excluded-drivers.store";
import { LedgerService } from "./ledger.service";
import { RatingsService } from "./ratings.service";
import { LoyaltyService } from "./loyalty.service";
import { CreateTripDto } from "./create-trip.dto";
import { estimateFare, haversineKm } from "./fare.util";

// Weekly driver bonus threshold — see getWeeklyIncentiveProgress(). A flat,
// code-defined tier rather than an admin-configurable campaign system,
// which is a real product surface (start/end dates, per-city tiers, budget
// caps) this single pass isn't going to invent well. Revisit once there's
// an actual ops person who needs to tune it.
const INCENTIVE_WEEKLY_TRIP_TARGET = 30;
const INCENTIVE_WEEKLY_BONUS = 2000;

// Expanding-radius search: try close by first, widen if nobody's around.
// This is the same core idea every ride app uses — sophistication (ETA-based
// ranking, acceptance-rate weighting, surge) layers on top of this later.
const SEARCH_RADII_KM = [1, 3, 5, 8];
const OFFER_TIMEOUT_MS = 15_000;

@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private prisma: PrismaService,
    private locationService: LocationService,
    private locationGateway: LocationGateway,
    private excludedDriversStore: ExcludedDriversStore,
    private ledgerService: LedgerService,
    private ratingsService: RatingsService,
    private loyaltyService: LoyaltyService,
  ) {}

  async createTrip(riderId: string, dto: CreateTripDto) {
    if (dto.fareType === "BID" && !dto.offeredFare) {
      throw new BadRequestException("offeredFare is required when fareType is BID");
    }

    const distanceKm = haversineKm(dto.pickupLat, dto.pickupLng, dto.dropoffLat, dto.dropoffLng);
    const fare =
      dto.fareType === "BID" ? dto.offeredFare : estimateFare(dto.vehicleType as any, distanceKm);

    const trip = await this.prisma.trip.create({
      data: {
        riderId,
        vehicleType: dto.vehicleType as any,
        fareType: (dto.fareType ?? "FIXED") as any,
        pickupLat: dto.pickupLat,
        pickupLng: dto.pickupLng,
        dropoffLat: dto.dropoffLat,
        dropoffLng: dto.dropoffLng,
        distanceKm,
        fare,
        offeredFare: dto.offeredFare,
      },
    });

    // Fire-and-forget: matching happens async so the rider's booking request
    // returns immediately with a trip id to poll/subscribe on, rather than
    // blocking the HTTP response on a driver search.
    this.attemptMatch(trip.id).catch((err) => this.logger.error(`Matching failed for ${trip.id}`, err));

    return trip;
  }

  private async attemptMatch(tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip || trip.status !== "REQUESTED" && trip.status !== "MATCHING") return;

    const excluded = await this.excludedDriversStore.getAll("trip", tripId);

    for (const radius of SEARCH_RADII_KM) {
      const nearby = await this.locationService.findNearbyDrivers(trip.pickupLat, trip.pickupLng, radius);
      const candidate = nearby.find((d) => !excluded.has(d.driverId));
      if (candidate) {
        await this.offerToDriver(tripId, candidate.driverId);
        return;
      }
    }

    // Nobody found at any radius — leave status as REQUESTED so a retry
    // (new driver coming online, rider expanding search) can pick it up.
    this.logger.warn(`No available drivers found for trip ${tripId}`);
  }

  private async offerToDriver(tripId: string, driverId: string) {
    const trip = await this.prisma.trip.update({
      where: { id: tripId },
      data: { status: "MATCHING", driverId },
    });

    // Include fare/fareType so the driver can actually see a rider's
    // proposed price before accepting a BID trip — same info an inDrive
    // driver sees on an incoming offer. fare is a Decimal column; Number()
    // before it leaves this function in a socket payload.
    this.locationGateway.emitToUser(driverId, "trip:offer", {
      tripId,
      expiresInMs: OFFER_TIMEOUT_MS,
      vehicleType: trip.vehicleType,
      fareType: trip.fareType,
      fare: trip.fare ? Number(trip.fare) : null,
      distanceKm: trip.distanceKm,
    });

    // Auto-cascade: if the driver hasn't accepted within the window, treat it
    // like a decline and offer the next-nearest candidate.
    setTimeout(async () => {
      const current = await this.prisma.trip.findUnique({ where: { id: tripId } });
      if (current?.status === "MATCHING" && current.driverId === driverId) {
        await this.handleDeclineOrTimeout(tripId, driverId);
      }
    }, OFFER_TIMEOUT_MS);
  }

  private async handleDeclineOrTimeout(tripId: string, driverId: string) {
    await this.excludedDriversStore.add("trip", tripId, driverId);
    await this.prisma.trip.update({ where: { id: tripId }, data: { status: "REQUESTED", driverId: null } });
    await this.attemptMatch(tripId);
  }

  async acceptTrip(tripId: string, driverId: string) {
    const trip = await this.getTripOr404(tripId);
    if (trip.status !== "MATCHING" || trip.driverId !== driverId) {
      throw new ForbiddenException("This trip is not awaiting your response");
    }
    const updated = await this.prisma.trip.update({
      where: { id: tripId },
      data: { status: "MATCHED", matchedAt: new Date() },
    });
    await this.excludedDriversStore.clear("trip", tripId);
    this.locationGateway.server.to(`trip:${tripId}`).emit("trip:matched", { tripId, driverId });
    this.locationGateway.emitToUser(trip.riderId, "trip:matched", { tripId, driverId });
    return updated;
  }

  async declineTrip(tripId: string, driverId: string) {
    const trip = await this.getTripOr404(tripId);
    if (trip.status !== "MATCHING" || trip.driverId !== driverId) {
      throw new ForbiddenException("This trip is not awaiting your response");
    }
    await this.handleDeclineOrTimeout(tripId, driverId);
    return { message: "Declined — offering to the next driver" };
  }

  async markArrived(tripId: string, driverId: string) {
    const trip = await this.getTripOr404(tripId);
    this.assertDriverOwnsTrip(trip, driverId, ["MATCHED"]);
    this.locationGateway.emitToUser(trip.riderId, "trip:driverArrived", { tripId });
    return { message: "Rider notified" };
  }

  async startTrip(tripId: string, driverId: string) {
    const trip = await this.getTripOr404(tripId);
    this.assertDriverOwnsTrip(trip, driverId, ["MATCHED"]);
    const updated = await this.prisma.trip.update({
      where: { id: tripId },
      data: { status: "IN_PROGRESS", startedAt: new Date() },
    });
    this.locationGateway.emitToUser(trip.riderId, "trip:started", { tripId });
    return updated;
  }

  async completeTrip(tripId: string, driverId: string) {
    const trip = await this.getTripOr404(tripId);
    this.assertDriverOwnsTrip(trip, driverId, ["IN_PROGRESS"]);
    const updated = await this.prisma.trip.update({
      where: { id: tripId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    // trip.fare is a Prisma Decimal now (see schema.prisma) — Number() it
    // before it goes anywhere that isn't straight back into another Decimal
    // column, since Socket.IO's JSON payload should carry a real number.
    this.locationGateway.emitToUser(trip.riderId, "trip:completed", { tripId, fare: trip.fare ? Number(trip.fare) : null });

    // driverId is guaranteed non-null here — assertDriverOwnsTrip already
    // confirmed trip.driverId === driverId above, so this can't be a trip
    // that somehow completed without a matched driver.
    if (trip.fare) {
      await this.ledgerService.recordTripPayout(driverId, tripId, trip.fare);
    }
    await this.loyaltyService.awardTripCompletionPoints(trip.riderId);

    return updated;
  }

  /** Real progress toward the flat weekly bonus, computed from actual
   * completed trips this week — not a hardcoded/fake number. */
  async getWeeklyIncentiveProgress(driverId: string) {
    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const tripsThisWeek = await this.prisma.trip.count({
      where: { driverId, status: "COMPLETED", completedAt: { gte: startOfWeek } },
    });

    return {
      tripsThisWeek,
      target: INCENTIVE_WEEKLY_TRIP_TARGET,
      bonusAmount: INCENTIVE_WEEKLY_BONUS,
      remaining: Math.max(0, INCENTIVE_WEEKLY_TRIP_TARGET - tripsThisWeek),
      achieved: tripsThisWeek >= INCENTIVE_WEEKLY_TRIP_TARGET,
      weekStarted: startOfWeek,
    };
  }

  /** Rider rates the driver after a completed trip. One rating per trip,
   * enforced by a unique constraint on Rating.tripId — see RatingsService. */
  async rateTrip(tripId: string, raterId: string, score: number, comment?: string) {
    const trip = await this.getTripOr404(tripId);
    if (trip.riderId !== raterId) throw new ForbiddenException("Only the rider can rate this trip");
    if (trip.status !== "COMPLETED") throw new BadRequestException("Can only rate a completed trip");
    if (!trip.driverId) throw new BadRequestException("This trip has no driver to rate");
    return this.ratingsService.rate({ raterId, rateeId: trip.driverId, score, comment, tripId });
  }

  async cancelTrip(tripId: string, userId: string) {
    const trip = await this.getTripOr404(tripId);
    if (trip.riderId !== userId && trip.driverId !== userId) {
      throw new ForbiddenException("Not your trip");
    }
    if (!["REQUESTED", "MATCHING", "MATCHED"].includes(trip.status)) {
      throw new BadRequestException(`Cannot cancel a trip that is ${trip.status}`);
    }
    const updated = await this.prisma.trip.update({
      where: { id: tripId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    await this.excludedDriversStore.clear("trip", tripId);
    const notify = trip.riderId === userId ? trip.driverId : trip.riderId;
    if (notify) this.locationGateway.emitToUser(notify, "trip:cancelled", { tripId });
    return updated;
  }

  async getTrip(tripId: string) {
    return this.getTripOr404(tripId);
  }

  async listMyTrips(userId: string) {
    return this.prisma.trip.findMany({
      where: { OR: [{ riderId: userId }, { driverId: userId }] },
      orderBy: { requestedAt: "desc" },
    });
  }

  private async getTripOr404(tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) throw new NotFoundException("Trip not found");
    return trip;
  }

  private assertDriverOwnsTrip(trip: { driverId: string | null; status: string }, driverId: string, allowedStatuses: string[]) {
    if (trip.driverId !== driverId) throw new ForbiddenException("Not your trip");
    if (!allowedStatuses.includes(trip.status)) {
      throw new BadRequestException(`Trip must be ${allowedStatuses.join(" or ")}, currently ${trip.status}`);
    }
  }
}
