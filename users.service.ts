import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UpdateVehicleDto } from "./dto/update-vehicle.dto";
import { NotificationsService } from "../notifications/notifications.service";
import { SetModeDto } from "./dto/set-mode.dto";

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

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
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: "APPROVED" },
    });
    await this.notificationsService.create(
      userId,
      "You're approved!",
      "Your driver verification is complete — you can go online and start accepting rides.",
    );
    return updated;
  }

  // DriverProfile was defined in the schema but never actually created
  // anywhere — KYC approval could flip a driver's status with zero vehicle
  // data behind it. upsert here so the driver's own Vehicle screen is what
  // actually creates the row, instead of it silently never existing.
  getVehicle(userId: string) {
    return this.prisma.driverProfile.findUnique({ where: { userId } });
  }

  upsertVehicle(userId: string, dto: UpdateVehicleDto) {
    return this.prisma.driverProfile.upsert({
      where: { userId },
      create: { userId, ...dto },
      update: { ...dto },
    });
  }

  // Dual-mode toggle — a driver only ever sits in one matching queue at a
  // time (see the DriverProfile.activeMode schema comment). One tap in the
  // app between "Ride" and "Food & Errands".
  //
  // Blocked while a job is in flight: nothing in trips/delivery/food-orders/
  // errands services checks activeMode once a driver is already assigned —
  // matching only reads it at offer time. Without this guard a driver mid-
  // delivery could flip queues and immediately start receiving offers from
  // the *other* queue while still supposed to be, say, driving a passenger,
  // or could dodge a pending offer/negotiation by switching away instead of
  // explicitly declining it. Checked against the same statuses each
  // service's own assertDriverOwns*() methods treat as "in progress".
  async setActiveMode(userId: string, dto: SetModeDto) {
    const [activeTrip, activeDelivery, activeFoodOrder, activeErrand] = await Promise.all([
      this.prisma.trip.count({ where: { driverId: userId, status: { in: ["MATCHING", "MATCHED", "IN_PROGRESS"] } } }),
      this.prisma.delivery.count({ where: { driverId: userId, status: { in: ["MATCHING", "MATCHED", "PICKED_UP", "IN_TRANSIT"] } } }),
      this.prisma.foodOrder.count({ where: { driverId: userId, status: { in: ["MATCHING", "ASSIGNED", "PICKED_UP"] } } }),
      this.prisma.errand.count({ where: { driverId: userId, status: { in: ["MATCHING", "ACCEPTED", "SHOPPING", "ON_THE_WAY"] } } }),
    ]);
    if (activeTrip + activeDelivery + activeFoodOrder + activeErrand > 0) {
      throw new BadRequestException("Finish or cancel your current job before switching queues");
    }

    return this.prisma.driverProfile.upsert({
      where: { userId },
      create: { userId, vehicleType: "bike", activeMode: dto.mode },
      update: { activeMode: dto.mode },
    });
  }
}
