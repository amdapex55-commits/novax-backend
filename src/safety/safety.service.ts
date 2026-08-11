import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { LocationGateway } from "../location/location.gateway";
import { AnalyticsService } from "../analytics/analytics.service";

@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
    private locationGateway: LocationGateway,
    private analyticsService: AnalyticsService,
  ) {}

  /**
   * Panic button. Writes a durable Incident row, pings every ADMIN's socket
   * so the ops dashboard lights up immediately, and notifies them.
   *
   * What this is NOT: a replacement for calling emergency services. The app
   * places a real phone call to 15 (Pakistan police) client-side at the same
   * moment this fires — see the safety sheet in the frontend. This endpoint
   * is the record + the ops alert, not the rescue.
   */
  /**
   * Is this user one of the two people on the job they named?
   *
   * Returns true when no context was supplied at all — a bare SOS with no job
   * attached is completely valid (someone pressing it between rides), and must
   * not be treated as a failed check.
   */
  private async ownsContext(
    userId: string,
    contextType?: string,
    contextId?: string,
  ): Promise<boolean> {
    if (!contextType || !contextId) return true;

    try {
      switch (contextType.toUpperCase()) {
        case "TRIP": {
          const row = await this.prisma.trip.findUnique({
            where: { id: contextId },
            select: { riderId: true, driverId: true },
          });
          return !!row && (row.riderId === userId || row.driverId === userId);
        }
        case "DELIVERY": {
          const row = await this.prisma.delivery.findUnique({
            where: { id: contextId },
            select: { senderId: true, driverId: true },
          });
          return !!row && (row.senderId === userId || row.driverId === userId);
        }
        case "FOOD_ORDER": {
          const row = await this.prisma.foodOrder.findUnique({
            where: { id: contextId },
            select: { customerId: true, driverId: true },
          });
          return !!row && (row.customerId === userId || row.driverId === userId);
        }
        case "ERRAND": {
          const row = await this.prisma.errand.findUnique({
            where: { id: contextId },
            select: { requesterId: true, driverId: true },
          });
          return !!row && (row.requesterId === userId || row.driverId === userId);
        }
        default:
          return false;
      }
    } catch (err) {
      // A malformed uuid throws in Prisma. Treat as "not verified" and let the
      // incident through without the context.
      this.logger.warn(`Could not verify incident context ${contextType}:${contextId} — ${(err as Error).message}`);
      return false;
    }
  }

  async raiseIncident(
    userId: string,
    input: { type?: string; contextType?: string; contextId?: string; lat?: number; lng?: number; note?: string },
  ) {
    // Verify the caller is actually on the job they're attaching this to.
    //
    // The incident is ALWAYS recorded either way — an SOS must never be
    // rejected because of a validation failure, that is the one request in
    // this system that has to survive being malformed. But an unverified
    // context is stripped rather than trusted: without this, anyone could
    // attach their panic to someone else's trip id and send ops to the wrong
    // person, at the worst possible moment to be sending them anywhere.
    const contextOk = await this.ownsContext(userId, input.contextType, input.contextId);
    if (input.contextId && !contextOk) {
      this.logger.warn(
        `Incident from user ${userId} claimed ${input.contextType}:${input.contextId} which isn't theirs — context dropped, incident still recorded.`,
      );
    }

    const incident = await this.prisma.incident.create({
      data: {
        userId,
        type: (input.type ?? "SOS") as any,
        contextType: contextOk ? input.contextType : null,
        contextId: contextOk ? input.contextId : null,
        lat: input.lat,
        lng: input.lng,
        note: contextOk
          ? input.note
          : // Keep the claim visible to ops rather than deleting it — if it's
            // a bug it needs finding, and if it's abuse it needs seeing.
            [input.note, input.contextId ? `[unverified context: ${input.contextType}:${input.contextId}]` : null]
              .filter(Boolean)
              .join(" ") || null,
      },
    });

    this.logger.error(
      `SOS/incident ${incident.id} raised by user ${userId} (${input.type ?? "SOS"}) at ${input.lat ?? "?"},${input.lng ?? "?"}`,
    );

    // Alert every admin — both a durable notification and a live socket
    // event, because an SOS that waits for someone to refresh a page is a
    // failure.
    const admins = await this.prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
    await Promise.all(
      admins.map((a) =>
        this.notificationsService.create(
          a.id,
          "🚨 SOS raised",
          `A user pressed the emergency button${input.contextType ? ` during a ${input.contextType.toLowerCase().replace("_", " ")}` : ""}. Open the ops dashboard now.`,
        ),
      ),
    );
    for (const a of admins) {
      this.locationGateway.emitToUser(a.id, "incident:new", {
        incidentId: incident.id,
        userId,
        type: incident.type,
        lat: incident.lat,
        lng: incident.lng,
        contextType: incident.contextType,
        contextId: incident.contextId,
      });
    }

    void this.analyticsService.track("sos_pressed", userId, null, {
      contextType: input.contextType,
      type: input.type ?? "SOS",
    });

    return incident;
  }

  listOpen() {
    return this.prisma.incident.findMany({
      where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { user: { select: { id: true, name: true, phone: true, role: true } } },
    });
  }

  listAll(limit = 200) {
    return this.prisma.incident.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { user: { select: { id: true, name: true, phone: true, role: true } } },
    });
  }

  async updateStatus(incidentId: string, adminId: string, status: "ACKNOWLEDGED" | "RESOLVED", resolution?: string) {
    const existing = await this.prisma.incident.findUnique({ where: { id: incidentId } });
    if (!existing) throw new NotFoundException("Incident not found");
    return this.prisma.incident.update({
      where: { id: incidentId },
      data: {
        status: status as any,
        resolution,
        handledById: adminId,
        handledAt: new Date(),
      },
    });
  }
}
