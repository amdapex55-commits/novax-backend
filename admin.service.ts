import { Injectable } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

const ACTIVE_TRIP_STATUSES = ["MATCHING", "MATCHED", "IN_PROGRESS"];
const ACTIVE_DELIVERY_STATUSES = ["MATCHING", "MATCHED", "PICKED_UP", "IN_TRANSIT"];

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  async getStats() {
    const [activeTrips, activeDeliveries, onlineDrivers, pendingKyc, totalUsers, totalDrivers] = await Promise.all([
      this.prisma.trip.count({ where: { status: { in: ACTIVE_TRIP_STATUSES } } }),
      this.prisma.delivery.count({ where: { status: { in: ACTIVE_DELIVERY_STATUSES } } }),
      this.prisma.driverProfile.count({ where: { isOnline: true } }),
      this.prisma.user.count({ where: { role: "DRIVER", kycStatus: "PENDING" } }),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: "DRIVER" } }),
    ]);
    return { activeTrips, activeDeliveries, onlineDrivers, pendingKyc, totalUsers, totalDrivers };
  }

  listPendingDrivers() {
    return this.prisma.user.findMany({
      where: { role: "DRIVER", kycStatus: "PENDING" },
      select: {
        id: true,
        phone: true,
        name: true,
        createdAt: true,
        driverProfile: { select: { vehicleType: true, vehiclePlate: true, cnicNumber: true, licenseDocUrl: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
  }

  listUsers() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        phone: true,
        name: true,
        role: true,
        kycStatus: true,
        rating: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }
}
