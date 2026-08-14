import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { LocationService } from "../location/location.service";
import { TripsService } from "../trips/trips.service";

/**
 * Nova Go — the simulated fleet that lets a store reviewer finish a trip.
 *
 * THE PROBLEM
 *
 * An App Store or Play reviewer opens the app in California at 3am Karachi
 * time, books a ride, and waits. No real rider is online, so nothing happens.
 * They conclude the app does not work and reject it. For this category that
 * is one of the most common rejections, and it has nothing to do with the
 * quality of the product.
 *
 * WHY THIS IS DANGEROUS, AND WHAT MAKES IT SAFE
 *
 * Anything that auto-accepts rides in production is a loaded gun pointed at
 * real customers. One wrong condition and a paying customer in Gulshan is
 * matched to a rider that does not exist, waits, and is never collected.
 *
 * Four independent gates, all of which must hold:
 *
 *   1. REVIEW_FLEET_ENABLED must be true. Off by default; off is safe.
 *   2. The TRIP must be flagged isTest — stamped at creation from the rider's
 *      isTestAccount, which no endpoint and no signup path can set.
 *   3. The DRIVER must be flagged isTestAccount.
 *   4. Matching already refuses to cross the streams: LocationService
 *      .filterEligible filters on isTestAccount in BOTH directions, so a real
 *      trip can never be offered to this fleet in the first place.
 *
 * Gate 4 alone would be sufficient. The others exist because a safety
 * property this important should not rest on one line of code being right.
 *
 * WHY POLLING RATHER THAN A HOOK IN TripsService
 *
 * A hook means dispatch code carries a branch for review accounts, and that
 * branch runs on every real booking. Polling keeps the whole mechanism
 * outside the path a real customer's trip takes — if this file is deleted,
 * production behaviour is unchanged.
 */
@Injectable()
export class ReviewFleetService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReviewFleetService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private locationService: LocationService,
    private tripsService: TripsService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<string>("REVIEW_FLEET_ENABLED", "false") === "true";
  }

  /** Where the simulated riders sit. Defaults to central Karachi. */
  private get home() {
    return {
      lat: Number(this.config.get<string>("REVIEW_FLEET_LAT", "24.8607")),
      lng: Number(this.config.get<string>("REVIEW_FLEET_LNG", "67.0011")),
    };
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.log("Review fleet disabled (REVIEW_FLEET_ENABLED != true)");
      return;
    }
    this.logger.warn(
      "REVIEW FLEET ENABLED — test-flagged drivers will be kept online and will auto-accept test trips. " +
        "This affects ONLY accounts with isTestAccount = true.",
    );
    // Every 4s: slow enough to be negligible load, fast enough that a reviewer
    // sees a rider appear while they are still looking at the screen.
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error(`Review fleet tick failed: ${err.message}`));
    }, 4_000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const drivers = await this.prisma.user.findMany({
      where: { role: "DRIVER", isTestAccount: true, isActive: true, kycStatus: "APPROVED" },
      select: { id: true },
    });
    if (drivers.length === 0) return;

    // Keep them online and their GPS fresh. filterFreshFixes rejects a fix
    // older than three minutes, so without this refresh the simulated fleet
    // ages out and the reviewer is back to "no riders available".
    await Promise.all(
      drivers.map(async (d) => {
        await this.locationService.updateDriverLocation(d.id, this.home.lat, this.home.lng);
        await this.prisma.driverProfile
          .updateMany({ where: { userId: d.id }, data: { isOnline: true } })
          .catch(() => undefined);
      }),
    );

    await this.advanceTestTrips(drivers.map((d) => d.id));
  }

  /**
   * Walk any in-flight TEST trip one step forward.
   *
   * Every query below is filtered on `isTest: true` as well as on the driver
   * being one of ours — gates 2 and 3. A trip that is not flagged is not
   * visible to this method at all.
   */
  private async advanceTestTrips(driverIds: string[]) {
    const trips = await this.prisma.trip.findMany({
      where: {
        isTest: true, // GATE 2 — never touches a real trip
        driverId: { in: driverIds }, // GATE 3 — never touches a real driver
        status: { in: ["MATCHING", "MATCHED", "IN_PROGRESS"] },
      },
      select: { id: true, status: true, driverId: true, matchedAt: true, startedAt: true },
    });

    for (const trip of trips) {
      if (!trip.driverId) continue;
      try {
        switch (trip.status) {
          case "MATCHING":
            // Accept quickly — the offer window is 15 seconds and a reviewer
            // watching a spinner for ten of them is already unimpressed.
            await this.tripsService.acceptTrip(trip.id, trip.driverId);
            this.logger.log(`Review fleet accepted test trip ${trip.id}`);
            break;

          case "MATCHED":
            // A pause long enough that the reviewer sees "rider on the way"
            // as a real state rather than a flicker, short enough that they
            // do not give up.
            if (this.olderThan(trip.matchedAt, 12_000)) {
              await this.tripsService.markArrived(trip.id, trip.driverId);
              await this.tripsService.startTrip(trip.id, trip.driverId);
              this.logger.log(`Review fleet started test trip ${trip.id}`);
            }
            break;

          case "IN_PROGRESS":
            // Long enough to open the tracking screen, try SOS and share the
            // ride — the things a reviewer is checking — before it completes.
            if (this.olderThan(trip.startedAt, 45_000)) {
              await this.tripsService.completeTrip(trip.id, trip.driverId);
              this.logger.log(`Review fleet completed test trip ${trip.id}`);
            }
            break;
        }
      } catch (err) {
        // One stuck test trip must not stop the loop for the others, and must
        // never surface to a reviewer as an error.
        this.logger.warn(`Review fleet could not advance ${trip.id}: ${(err as Error).message}`);
      }
    }
  }

  private olderThan(at: Date | null, ms: number) {
    return !!at && Date.now() - new Date(at).getTime() >= ms;
  }
}
