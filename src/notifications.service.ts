import { Injectable } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  create(userId: string, title: string, body: string) {
    return this.prisma.notification.create({ data: { userId, title, body } });
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
