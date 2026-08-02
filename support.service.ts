import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SupportService {
  constructor(private prisma: PrismaService) {}

  createTicket(userId: string, subject: string, message: string) {
    return this.prisma.supportTicket.create({ data: { userId, subject, message } });
  }

  listMine(userId: string) {
    return this.prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  listAll() {
    return this.prisma.supportTicket.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { user: { select: { phone: true, name: true, role: true } } },
    });
  }
}
