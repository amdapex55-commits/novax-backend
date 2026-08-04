import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { NotificationsService } from "./notifications.service";
import { LocationGateway } from "./location.gateway";
import { AnalyticsService } from "./analytics.service";

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
  async raiseIncident(
    userId: string,
    input: { type?: string; contextType?: string; contextId?: string; lat?: number; lng?: number; note?: string },
  ) {
    const incident = await this.prisma.incident.create({
      data: {
        userId,
        type: (input.type ?? "SOS") as any,
        contextType: input.contextType,
        contextId: input.contextId,
        lat: input.lat,
        lng: input.lng,
        note: input.note,
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
