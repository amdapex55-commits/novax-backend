import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { ANALYTICS_EVENT_SET } from "./analytics.constants";

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Record one funnel event.
   *
   * Deliberately never throws: analytics is observability, not business
   * logic. A failed insert here must not roll back a completed ride or block
   * an OTP — the worst acceptable outcome is a gap in a chart.
   * Callers can `void track(...)` without awaiting.
   */
  async track(name: string, userId?: string | null, role?: string | null, props?: Record<string, unknown>) {
    try {
      if (!ANALYTICS_EVENT_SET.has(name)) {
        // Unknown name = a typo at a call site, or a client sending junk.
        // Logged, not stored, so the funnel stays clean.
        this.logger.warn(`Ignoring unknown analytics event "${name}"`);
        return;
      }
      await this.prisma.analyticsEvent.create({
        data: {
          name,
          userId: userId ?? null,
          role: role ?? null,
          props: (props ?? {}) as any,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to record analytics event "${name}"`, err as Error);
    }
  }

  /**
   * Funnel counts over a window, as the ops dashboard shows them.
   * One grouped query rather than N counts.
   */
  async getFunnel(days = 7) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.analyticsEvent.groupBy({
      by: ["name"],
      where: { createdAt: { gte: since } },
      _count: { name: true },
    });
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.name] = r._count.name;

    // Conversion rates worth watching daily — each is "of the people who got
    // to step A, how many reached step B", which is where drop-off hides.
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
    return {
      windowDays: days,
      counts,
      conversion: {
        otpVerifiedOfRequested: pct(counts.otp_verified || 0, counts.otp_requested || 0),
        rideMatchedOfRequested: pct(counts.ride_driver_matched || 0, counts.ride_requested || 0),
        rideCompletedOfRequested: pct(counts.ride_completed || 0, counts.ride_requested || 0),
        foodDeliveredOfPlaced: pct(counts.food_delivered || 0, counts.food_order_placed || 0),
        driverAcceptOfOffered: pct(counts.driver_offer_accepted || 0, counts.driver_offer_received || 0),
      },
    };
  }
}
