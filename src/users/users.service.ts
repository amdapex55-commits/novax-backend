import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UpdateProfileDto } from "./dto/update-profile.dto";

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        name: true,
        role: true,
        kycStatus: true,
        rating: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException("User not found");
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    return this.prisma.user.update({
      where: { id: userId },
      data: dto,
      select: { id: true, phone: true, name: true, role: true },
    });
  }

  // Admin-only in practice (guard this route with @Roles("ADMIN")) — approve a
  // driver's KYC so they're allowed to go online. Never self-service.
  async approveDriverKyc(userId: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: "APPROVED" },
    });
  }
}
