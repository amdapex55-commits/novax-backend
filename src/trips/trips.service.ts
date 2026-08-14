import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Logger } from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { LocationService } from "../location/location.service";
import { LocationGateway } from "../location/location.gateway";
import { ExcludedDriversStore } from "../location/excluded-drivers.store";
import { LedgerService } from "../ledger/ledger.service";
import { RatingsService } from "../ratings/ratings.service";
import { LoyaltyService } from "../loyalty/loyalty.service";
import { CreateTripDto } from "./dto/create-trip.dto";
import { FARE_VERSION, estimateFare, haversineKm, roadEstimateFromStraightLine } from "./fare.util";
import { scoreDriver, ratesFromCounters, idleMinutesSince } from "./dispatch.util";
import { LaunchPolicyService } from "../launch/launch-policy.service";

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

// How many of the nearest candidates get scored. Beyond this the extra
// database work is spent reordering drivers who were never going to win on
// distance anyway.
const DISPATCH_SHORTLIST = 8;

// The escalation ladder behind "a person is watching every ride".
// 90 seconds is roughly six offer cycles — long enough that a normal busy
// moment resolves itself, short enough that a customer has not yet decided
// the app is broken.
const OPS_ALERT_MS = 90_000;
const OPS_ESCALATE_MS = 180_000;

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
    private launchPolicy: LaunchPolicyService,
  ) {}

  async createTrip(riderId: string, dto: CreateTripDto) {
    // Pilot rules, enforced here rather than only in the app: bike-only,
    // fixed-fare, inside the launch zone, inside operating hours. The
    // frontend already hides all of this, but hiding is not enforcing — a
    // modified client, a stale cached bundle or plain curl would otherwise
    // book a car at 3am in a city we don't operate in.
    this.launchPolicy.assertRideAllowed({
      vehicleType: dto.vehicleType,
      fareType: dto.fareType,
      pickupLat: dto.pickupLat,
      pickupLng: dto.pickupLng,
    });

    if (dto.fareType === "BID" && !dto.offeredFare) {
      throw new BadRequestException("offeredFare is required when fareType is BID");
    }

    // ---- Distance ----------------------------------------------------
    // Prefer the ROAD distance the client measured (it's what the customer
    // was quoted on), but never trust it unchecked: a modified client could
    // otherwise claim a 12km ride is 0.2km and pay the minimum fare.
    //
    // Sanity band: a road route is always at least the straight-line
    // distance, and in a city grid is rarely more than ~3× it. Anything
    // outside that is either a bug or an attack, and we fall back to our
    // own estimate rather than honouring it.
    const straightLineKm = haversineKm(dto.pickupLat, dto.pickupLng, dto.dropoffLat, dto.dropoffLng);

    let distanceKm: number;
    let distanceSource: "ROUTED" | "ESTIMATED";

    const claimed = dto.roadDistanceKm;
    const plausible =
      typeof claimed === "number" &&
      Number.isFinite(claimed) &&
      // 0.98 rather than 1.0: floating-point and slightly different geoid
      // models mean a genuine route can come back a hair under haversine.
      claimed >= straightLineKm * 0.98 &&
      claimed <= straightLineKm * 3;

    if (plausible) {
      distanceKm = claimed!;
      distanceSource = "ROUTED";
    } else {
      distanceKm = roadEstimateFromStraightLine(straightLineKm);
      distanceSource = "ESTIMATED";
      if (claimed !== undefined) {
        this.logger.warn(
          `Rejected implausible roadDistanceKm=${claimed} for straight-line ${straightLineKm.toFixed(2)}km (rider ${riderId})`,
        );
      }
    }

    const fare =
      dto.fareType === "BID"
        ? dto.offeredFare
        : estimateFare(dto.vehicleType as any, distanceKm, dto.roadDurationMinutes);

    const trip = await this.prisma.trip.create({
      data: {
        riderId,
        vehicleType: dto.vehicleType as any,
        fareType: (dto.fareType ?? "FIXED") as any,
        pickupLat: dto.pickupLat,
        pickupLng: dto.pickupLng,
        dropoffLat: dto.dropoffLat,
        dropoffLng: dto.dropoffLng,
        pickupLabel: dto.pickupLabel?.trim() || null,
        dropoffLabel: dto.dropoffLabel?.trim() || null,
        distanceKm,
        distanceSource,
        pickupAccuracyMeters: dto.pickupAccuracyMeters,
        pickupNote: dto.pickupNote,
        pickupNoteAudioUrl: dto.pickupNoteAudioUrl,
        fare,
        // THE FARE AUDIT TRAIL. See the schema comment on these columns.
        //
        // quoted and accepted are written together here because in this app
        // they are genuinely the same instant: the customer is looking at the
        // number when they press Confirm, and this request IS that press.
        // They stay separate columns because that stops being true the moment
        // a quote can be held and booked later (a scheduled ride), and a
        // schema that cannot express the difference is one that hides the
        // drift it was added to catch.
        //
        // Note this is the SERVER's fare, not the client's. The customer saw
        // a client-side estimate; if the two disagree the server's is what
        // they are held to, and acceptedFare records that rather than what
        // the phone happened to display.
        quotedFare: fare,
        acceptedFare: fare,
        quotedAt: new Date(),
        fareVersion: FARE_VERSION,
        offeredFare: dto.offeredFare,
        // Kept out of `fare` on purpose — the tip is settled to the driver in
        // full, with no commission taken (see completeTrip / commission.util).
        tipAmount: dto.tipAmount && dto.tipAmount > 0 ? dto.tipAmount : null,
      },
    });

    // Fire-and-forget: matching happens async so the rider's booking request
    // returns immediately with a trip id to poll/subscribe on, rather than
    // blocking the HTTP response on a driver search.
    this.attemptMatch(trip.id).catch((err) => this.logger.error(`Matching failed for ${trip.id}`, err));

    /* THE ESCALATION CLOCK RUNS WHETHER OR NOT MATCHING FAILS LOUDLY.
       escalateIfStuck is also called from the decline path and the
       nobody-found path, but neither is guaranteed to fire at the right
       moment: a job cycling through 15-second offers reaches 90 seconds
       mid-cycle, and one with no drivers at all reaches it with nothing
       running. These two timers are what make the promise time-based.

       In-process timers, so a restart loses them. That is survivable and
       deliberately not over-engineered: the ops desk's stuck-jobs list is a
       DATABASE query on requestedAt, so a dispatcher still sees the job.
       What a restart loses is the customer-facing message, not the ops
       safety net. If that becomes unacceptable, this belongs in a scheduled
       sweep rather than a queue. */
    setTimeout(() => {
      this.escalateIfStuck(trip.id).catch(() => undefined);
    }, OPS_ALERT_MS).unref?.();
    setTimeout(() => {
      this.escalateIfStuck(trip.id).catch(() => undefined);
    }, OPS_ESCALATE_MS).unref?.();

    return trip;
  }

  private async attemptMatch(tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip || trip.status !== "REQUESTED" && trip.status !== "MATCHING") return;

    const excluded = await this.excludedDriversStore.getAll("trip", tripId);

    for (const radius of SEARCH_RADII_KM) {
      const nearby = await this.locationService.findNearbyDrivers(trip.pickupLat, trip.pickupLng, radius);
      const eligible = nearby.filter((d) => !excluded.has(d.driverId));
      if (eligible.length === 0) continue;

      // RANK, DON'T TAKE THE FIRST.
      //
      // findNearbyDrivers returns nearest-first, and taking [0] means a rider
      // who declines everything is offered everything — they stay nearest,
      // declining costs them nothing, and every decline is another 15 seconds
      // on a waiting customer. See dispatch.util.ts for the weights and why
      // distance still dominates.
      //
      // Only the shortlist is scored: pulling reputation counters for every
      // driver in an 8km radius would be a query per candidate on the
      // critical path of a booking, to reorder people who were never going to
      // be picked.
      const best = await this.rankCandidates(eligible.slice(0, DISPATCH_SHORTLIST));
      if (best) {
        await this.offerToDriver(tripId, best);
        return;
      }
    }

    // NOBODY, AT ANY RADIUS. This used to log a warning and stop — the trip
    // sat in REQUESTED, nothing retried it, and the customer watched a
    // spinner until they gave up. Nothing was ever going to change that
    // state except another booking attempt.
    //
    // Now it is recorded and escalated, so the ops desk sees it and the
    // customer is told the truth. See escalateIfStuck().
    await this.prisma.trip.update({
      where: { id: tripId },
      data: { noDriverFoundAt: trip.noDriverFoundAt ?? new Date() },
    }).catch(() => undefined);
    this.logger.warn(`No available drivers found for trip ${tripId}`);
    await this.escalateIfStuck(tripId);
  }

  /**
   * Score a shortlist and return the best driverId, or null.
   *
   * Reputation lives on DriverProfile as counters (see the schema comment) so
   * this is one query for the whole shortlist rather than one per driver.
   */
  private async rankCandidates(
    candidates: Array<{ driverId: string; distanceKm: number }>,
  ): Promise<string | null> {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].driverId;

    const ids = candidates.map((c) => c.driverId);
    const [profiles, users] = await Promise.all([
      this.prisma.driverProfile.findMany({
        where: { userId: { in: ids } },
        select: {
          userId: true, offersSent: true, offersAccepted: true,
          offersDeclined: true, tripsCancelled: true, lastCompletedAt: true,
        },
      }),
      this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, rating: true } }),
    ]);
    const byProfile = new Map(profiles.map((p) => [p.userId, p]));
    const byRating = new Map(users.map((u) => [u.id, u.rating]));

    let bestId: string | null = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const p = byProfile.get(c.driverId);
      const rates = p
        ? ratesFromCounters(p)
        : { acceptanceRate: null, cancellationRate: null };
      const score = scoreDriver({
        distanceKm: c.distanceKm,
        acceptanceRate: rates.acceptanceRate,
        cancellationRate: rates.cancellationRate,
        rating: byRating.get(c.driverId) ?? null,
        idleMinutes: idleMinutesSince(p?.lastCompletedAt),
      });
      if (score > bestScore) { bestScore = score; bestId = c.driverId; }
    }
    return bestId;
  }

  /**
   * "A person is watching every ride" is the product promise. This is the
   * part that makes it measurable.
   *
   *   90s  — ops is told. Automatic matching is still trying.
   *   3min — ops must place it by hand, and the customer is told a person
   *          has picked it up.
   *
   * Both thresholds are stamped on the trip rather than computed from
   * requestedAt at read time, so the ops queue can index them and so "when
   * did we notice" survives into the dispute record.
   */
  private async escalateIfStuck(tripId: string) {
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip) return;
    // Only jobs still looking for someone can be stuck.
    if (!["REQUESTED", "MATCHING"].includes(trip.status)) return;

    const waitingMs = Date.now() - new Date(trip.requestedAt).getTime();

    if (waitingMs >= OPS_ESCALATE_MS && !trip.opsEscalatedAt) {
      await this.prisma.trip.update({
        where: { id: tripId },
        data: { opsEscalatedAt: new Date(), opsAlertedAt: trip.opsAlertedAt ?? new Date() },
      });
      // The customer stops seeing a bare spinner and starts seeing a person.
      this.locationGateway.emitToUser(trip.riderId, "trip:opsEscalated", {
        tripId,
        message: "Nova Go Ops is placing this ride by hand.",
      });
      this.logger.error(`Trip ${tripId} escalated to manual dispatch after ${Math.round(waitingMs / 1000)}s`);
      return;
    }

    if (waitingMs >= OPS_ALERT_MS && !trip.opsAlertedAt) {
      await this.prisma.trip.update({ where: { id: tripId }, data: { opsAlertedAt: new Date() } });
      this.locationGateway.emitToUser(trip.riderId, "trip:opsWatching", {
        tripId,
        message: "Nova Go Ops is watching this ride.",
      });
      this.logger.warn(`Trip ${tripId} unmatched after ${Math.round(waitingMs / 1000)}s — ops alerted`);
    }
  }

  private async offerToDriver(tripId: string, driverId: string) {
    const trip = await this.prisma.trip.update({
      where: { id: tripId },
      data: { status: "MATCHING", driverId, offerCount: { increment: 1 } },
    });

    // Reputation counters (see the DriverProfile schema comment). Fire and
    // forget: a counter that fails to increment skews a ranking signal by a
    // fraction of a percent, and is never worth failing a dispatch over.
    this.prisma.driverProfile
      .update({ where: { userId: driverId }, data: { offersSent: { increment: 1 }, lastOfferAt: new Date() } })
      .catch(() => undefined);

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
      // The tip is the entire point of Fast Match — it only makes a job more
      // attractive if the driver can see it while deciding, so it rides in
      // the offer payload alongside the fare.
      tipAmount: trip.tipAmount ? Number(trip.tipAmount) : null,
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
    this.prisma.driverProfile
      .update({ where: { userId: driverId }, data: { offersDeclined: { increment: 1 } } })
      .catch(() => undefined);
    await this.prisma.trip.update({ where: { id: tripId }, data: { status: "REQUESTED", driverId: null } });
    // Check the clock on every cycle, not only when the radius search comes
    // back empty. A job being declined round after round is the case a
    // customer feels most — the spinner never stops and nothing is wrong
    // enough to trip the no-drivers path.
    await this.escalateIfStuck(tripId);
    await this.attemptMatch(tripId);
  }

  async acceptTrip(tripId: string, driverId: string) {
    // Atomic claim, not read-then-write.
    //
    // The old shape was: fetch the job, check status === MATCHING and that the
    // offer belongs to this driver, then update. Two requests interleaving
    // between the check and the update both pass, and both write MATCHED — a
    // double-tap on a flaky Karachi connection is enough. The 15-second
    // cascade makes it worse: the timeout can hand the job to the next driver
    // while this driver's accept is still in flight, and the loser only finds
    // out when they arrive at a pickup someone else is already doing.
    //
    // updateMany with the guard in the WHERE clause makes the check and the
    // write one statement. The database decides the winner; count === 0 means
    // this driver lost, which is the same answer the old check gave, just
    // truthfully.
    const claimed = await this.prisma.trip.updateMany({
      where: { id: tripId, status: "MATCHING", driverId },
      data: { status: "MATCHED", matchedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new ForbiddenException("This trip is not awaiting your response");
    }
    const trip = await this.getTripOr404(tripId);
    const updated = trip;
    await this.excludedDriversStore.clear("trip", tripId);
    this.locationGateway.server.to(`trip:${tripId}`).emit("trip:matched", { tripId, driverId });
    this.locationGateway.emitToUser(trip.riderId, "trip:matched", { tripId, driverId });
    this.prisma.driverProfile
      .update({ where: { userId: driverId }, data: { offersAccepted: { increment: 1 } } })
      .catch(() => undefined);
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

    // Conditional transition: only flip IN_PROGRESS -> COMPLETED, and only
    // act if THIS call is the one that actually made the change. Two
    // concurrent calls (a network retry, an impatient double-tap) both used
    // to pass the status check above and both write a payout — paying the
    // driver twice for one trip. updateMany returns a count, so the loser
    // sees 0 and returns without touching the ledger.
    const claimed = await this.prisma.trip.updateMany({
      where: { id: tripId, status: "IN_PROGRESS" },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    if (claimed.count === 0) {
      // Someone else already completed it — return current state, don't pay again.
      return this.getTripOr404(tripId);
    }
    // STAMP THE FINAL FARE AND CHECK IT AGAINST WHAT WAS PROMISED.
    //
    // The fare is fixed at booking and nothing in this codebase is supposed to
    // change it afterwards. That is exactly why it is worth checking: an
    // invariant nobody verifies is an invariant that quietly stops holding.
    //
    // A drift here means a customer is about to be asked for a different
    // number than the one they agreed to, at the kerb, in cash, with no way
    // to appeal. So it is recorded on the trip and logged at error level for
    // the ops desk — and the fare is NOT silently corrected, because the
    // honest answer to "these disagree" is to charge what was promised.
    const promised = trip.acceptedFare != null ? Number(trip.acceptedFare) : null;
    const charged = trip.fare != null ? Number(trip.fare) : null;
    const drifted = promised != null && charged != null && Math.abs(promised - charged) >= 0.01;

    await this.prisma.trip.update({
      where: { id: tripId },
      data: {
        // Honour the promise: what we charge is what was accepted, whenever
        // we have an accepted figure to honour.
        finalFare: promised ?? charged,
        ...(drifted ? { fareDriftedAt: new Date() } : {}),
      },
    });

    // Idle time is measured from here, so it must be stamped even when the
    // driver goes straight into another job.
    this.prisma.driverProfile
      .update({ where: { userId: driverId }, data: { lastCompletedAt: new Date() } })
      .catch(() => undefined);

    if (drifted) {
      this.logger.error(
        `FARE DRIFT on trip ${tripId}: accepted Rs ${promised}, computed Rs ${charged}. ` +
        `Charging the accepted fare. This should never happen — investigate.`,
      );
    }

    const updated = await this.getTripOr404(tripId);
    // trip.fare is a Prisma Decimal now (see schema.prisma) — Number() it
    // before it goes anywhere that isn't straight back into another Decimal
    // column, since Socket.IO's JSON payload should carry a real number.
    this.locationGateway.emitToUser(trip.riderId, "trip:completed", { tripId, fare: trip.fare ? Number(trip.fare) : null });

    // driverId is guaranteed non-null here — assertDriverOwnsTrip already
    // confirmed trip.driverId === driverId above, so this can't be a trip
    // that somehow completed without a matched driver.
    if (trip.fare) {
      await this.ledgerService.recordTripPayout(driverId, tripId, trip.fare, updated.tipAmount);
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

  async cancelTrip(tripId: string, userId: string, dto?: { reason?: string; note?: string }) {
    const trip = await this.getTripOr404(tripId);
    if (trip.riderId !== userId && trip.driverId !== userId) {
      throw new ForbiddenException("Not your trip");
    }
    if (!["REQUESTED", "MATCHING", "MATCHED"].includes(trip.status)) {
      throw new BadRequestException(`Cannot cancel a trip that is ${trip.status}`);
    }

    // Recorded, not just counted. A cancellation without a reason tells you
    // the rate went up and nothing about what to do — and the two cases you
    // most need to separate (a rider demanding more than the fixed fare
    // versus a customer who mis-pinned their pickup) look identical without
    // it. DRIVER_ASKED_MORE in particular has to be countable per driver,
    // because a pattern of it ends the relationship.
    const cancelledBy = trip.riderId === userId ? "RIDER" : "DRIVER";
    if (dto?.reason === "DRIVER_ASKED_MORE") {
      this.logger.warn(
        `Trip ${tripId}: customer reports driver ${trip.driverId} asked for more than the quoted fare.` +
          (dto.note ? ` Note: ${dto.note}` : ""),
      );
    }

    // A driver who accepts and then cancels costs the customer far more than
    // one who declines up front: they have already stopped looking. Counted
    // separately from declines so the score can weight it separately — see
    // `reliability` in dispatch.util.ts. Only counted when the driver had
    // actually taken the job (MATCHED); cancelling an offer they never
    // accepted is a decline, and is already counted as one.
    if (cancelledBy === "DRIVER" && trip.driverId && trip.status === "MATCHED") {
      this.prisma.driverProfile
        .update({ where: { userId: trip.driverId }, data: { tripsCancelled: { increment: 1 } } })
        .catch(() => undefined);
    }

    const updated = await this.prisma.trip.update({
      where: { id: tripId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledBy,
        cancelReason: dto?.reason ?? null,
        cancelNote: dto?.note?.trim() || null,
      },
    });
    await this.excludedDriversStore.clear("trip", tripId);
    const notify = trip.riderId === userId ? trip.driverId : trip.riderId;
    if (notify) this.locationGateway.emitToUser(notify, "trip:cancelled", { tripId });
    return updated;
  }

  // requesterId is required, not optional — a JWT alone used to be enough to
  // read ANY trip by guessing its id (IDOR), exposing another user's pickup/
  // dropoff coordinates and fare. ADMIN is allowed through for ops tooling.
  async getTrip(tripId: string, requesterId: string, requesterRole?: string) {
    const trip = await this.getTripOr404(tripId);
    if (requesterRole !== "ADMIN" && trip.riderId !== requesterId && trip.driverId !== requesterId) {
      throw new ForbiddenException("Not your trip");
    }
    // Include the other party's identity — the tracking screen shows a
    // "who is picking you up" trust card (name, rating, plate), which is the
    // single biggest trust signal in a ride app. Only fields safe for the
    // counterparty to see; no CNIC, no payout details.
    const [driver, driverProfile, rider, driverTripCount] = await Promise.all([
      trip.driverId
        ? this.prisma.user.findUnique({ where: { id: trip.driverId }, select: { name: true, rating: true, phone: true } })
        : null,
      trip.driverId
        ? this.prisma.driverProfile.findUnique({ where: { userId: trip.driverId }, select: { vehicleType: true, vehiclePlate: true } })
        : null,
      this.prisma.user.findUnique({ where: { id: trip.riderId }, select: { name: true, rating: true, phone: true } }),
      /* HOW MANY TRIPS THIS RIDER HAS ACTUALLY FINISHED.
         A star rating out of five is a weak signal early on — a rider with
         one 5-star trip outranks one with two hundred 4.8s, and a customer
         deciding whether to get on the back of a stranger's bike in Karachi
         can tell the difference. Experience is the number that answers the
         question they are really asking.
         Counted rather than denormalised onto DriverProfile: at pilot volume
         this is an indexed count on a column the matcher already filters by,
         and a stored counter is one more thing that can drift from reality. */
      trip.driverId
        ? this.prisma.trip.count({ where: { driverId: trip.driverId, status: "COMPLETED" } })
        : Promise.resolve(0),
    ]);
    return { ...trip, driver, driverProfile, driverTripCount, rider };
  }

  /** Mint (or reuse) the share token for "send my live ride to someone".
   * Only the rider or the assigned driver can create one. */
  async createShareLink(tripId: string, requesterId: string) {
    const trip = await this.getTripOr404(tripId);
    if (trip.riderId !== requesterId && trip.driverId !== requesterId) {
      throw new ForbiddenException("Not your trip");
    }
    if (trip.shareToken) return { shareToken: trip.shareToken };
    // 32 hex chars of CSPRNG — not guessable by brute force, and stable for
    // the life of the trip so a link already sent to family keeps working.
    const shareToken = randomBytes(16).toString("hex");
    await this.prisma.trip.update({ where: { id: tripId }, data: { shareToken } });
    return { shareToken };
  }

  /** PUBLIC read (no auth) for a shared trip link.
   *
   * Minimal projection on purpose: whoever holds this link is an unknown
   * third party the rider chose to trust with "where am I", not with the
   * rider's phone number, the driver's full identity, or the fare. Anything
   * added here is visible to anyone the link is forwarded to. */
  async getSharedTrip(shareToken: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { shareToken },
      select: {
        id: true,
        status: true,
        vehicleType: true,
        pickupLat: true,
        pickupLng: true,
        dropoffLat: true,
        dropoffLng: true,
        matchedAt: true,
        startedAt: true,
        completedAt: true,
        driver: { select: { name: true, rating: true } },
        rider: { select: { name: true } },
      },
    });
    if (!trip) throw new NotFoundException("This share link is not valid");

    const driverLocation = trip.driver
      ? await this.locationService.getDriverLocation((await this.prisma.trip.findUnique({ where: { id: trip.id }, select: { driverId: true } }))!.driverId!)
      : null;

    return {
      id: trip.id,
      status: trip.status,
      vehicleType: trip.vehicleType,
      pickup: { lat: trip.pickupLat, lng: trip.pickupLng },
      dropoff: { lat: trip.dropoffLat, lng: trip.dropoffLng },
      // First name only — enough to recognise, not a full identity dump.
      driverFirstName: trip.driver?.name ? trip.driver.name.split(" ")[0] : null,
      driverRating: trip.driver?.rating ?? null,
      riderFirstName: trip.rider?.name ? trip.rider.name.split(" ")[0] : null,
      driverLocation,
      matchedAt: trip.matchedAt,
      startedAt: trip.startedAt,
      completedAt: trip.completedAt,
    };
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
