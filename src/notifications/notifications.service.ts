import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PushService, PushMessage } from "../push/push.service";

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private push: PushService,
  ) {}

  /** Write to the in-app log only. Rarely what you want — see notify(). */
  create(userId: string, title: string, body: string) {
    return this.prisma.notification.create({ data: { userId, title, body } });
  }

  /**
   * Tell a user something: in-app row AND a push, from one call.
   *
   * WHY THESE ARE DELIBERATELY THE SAME CALL
   *
   * The obvious alternative is a separate push call at each site that already
   * writes a notification. That guarantees they drift: someone adds a push for
   * a new event and forgets the row, so it never appears in the notifications
   * screen, or writes the row and forgets the push, so it never reaches a
   * pocket. Both failures are invisible in code review and only show up as "I
   * never got told".
   *
   * One call, two destinations, always consistent. The push is awaited but
   * cannot throw (see PushService) — a trip does not fail to complete because
   * Google returned a 503.
   */
  async notify(
    userId: string,
    app: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    const row = await this.prisma.notification.create({ data: { userId, title, body } });
    const message: PushMessage = { title, body, data: { ...data, notificationId: row.id } };
    await this.push.sendToUser(userId, app, message);
    return row;
  }

  listMine(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  async markRead(userId: string, id: string) {
    // Scoped to userId in the where clause (not just the id) so one user
    // can never mark — or even discover the existence of — another user's
    // notification by guessing an id.
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    });
    return { message: "Marked read" };
  }
}
