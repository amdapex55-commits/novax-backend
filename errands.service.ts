import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LocationService } from "../location/location.service";
import { LocationGateway } from "../location/location.gateway";
import { ExcludedDriversStore } from "../location/excluded-drivers.store";
import { LedgerService } from "../ledger/ledger.service";
import { LoyaltyService } from "../loyalty/loyalty.service";
import { CreateErrandDto } from "./dto/create-errand.dto";
import { estimateFare, haversineKm } from "../trips/fare.util";

// Same expanding-radius cascade shape as Trips/Delivery/FoodOrders, scoped
// to FOOD_ERRAND-mode drivers and centered on the store (not the requester)
// since that's where the driver needs to go first.
const SEARCH_RADII_KM = [1, 3, 5, 8];
const OFFER_TIMEOUT_MS = 15_000;

@Injectable()
export class ErrandsService {
  private readonly logger = new Logger(ErrandsService.name);

  constructor(
    private prisma: PrismaService,
    private locationService: LocationService,
    private locationGateway: LocationGateway,
    private excludedDriversStore: ExcludedDriversStore,
    private ledgerService: LedgerService,
    private loyaltyService: LoyaltyService,
  ) {}

  async createErrand(requesterId: string, dto: CreateErrandDto) {
    const distanceKm = haversineKm(dto.storeLat, dto.storeLng, dto.dropoffLat, dto.dropoffLng);
    const serviceFee = estimateFare("ERRAND", distanceKm);

    const errand = await this.prisma.errand.create({
      data: {
        requesterId,
        storeLabel: dto.storeLabel,
        storeLat: dto.storeLat,
        storeLng: dto.storeLng,
        dropoffLabel: dto.dropoffLabel,
        dropoffLat: dto.dropoffLat,
        dropoffLng: dto.dropoffLng,
        itemsDescription: dto.itemsDescription,
        estimatedBudget: dto.estimatedBudget,
        serviceFee,
      },
    });

    this.attemptMatch(errand.id).catch((err) => this.logger.error(`Matching failed for errand ${errand.id}`, err));
    return errand;
  }

  private async attemptMatch(errandId: string) {
    const errand = await this.prisma.errand.findUnique({ where: { id: errandId } });
    if (!errand || (errand.status !== "REQUESTED" && errand.status !== "MATCHING")) return;

    const excluded = await this.excludedDriversStore.getAll("errand", errandId);

    for (const radius of SEARCH_RADII_KM) {
      const nearby = await this.locationService.findNearbyDriversForMode(errand.storeLat, errand.storeLng, radius, "FOOD_ERRAND");
      const candidate = nearby.find((d) => !excluded.has(d.driverId));
      if (candidate) {
        await this.offerToDriver(errandId, candidate.driverId);
        return;
      }
    }
    this.logger.warn(`No available FOOD_ERRAND drivers found for errand ${errandId}`);
  }

  private async offerToDriver(errandId: string, driverId: string) {
    await this.prisma.errand.update({ where: { id: errandId }, data: { status: "MATCHING", driverId } });
    this.locationGateway.emitToUser(driverId, "errand:offer", { errandId, expiresInMs: OFFER_TIMEOUT_MS });

    setTimeout(async () => {
      const current = await this.prisma.errand.findUnique({ where: { id: errandId } });
      if (current?.status === "MATCHING" && current.driverId === driverId) {
        await this.handleDeclineOrTimeout(errandId, driverId);
      }
    }, OFFER_TIMEOUT_MS);
  }

  private async handleDeclineOrTimeout(errandId: string, driverId: string) {
    await this.excludedDriversStore.add("errand", errandId, driverId);
    await this.prisma.errand.update({ where: { id: errandId }, data: { status: "REQUESTED", driverId: null } });
    await this.attemptMatch(errandId);
  }

  async acceptOffer(driverId: string, errandId: string) {
    const errand = await this.getErrandOr404(errandId);
    if (errand.status !== "MATCHING" || errand.driverId !== driverId) {
      throw new ForbiddenException("This errand is not awaiting your response");
    }
    const updated = await this.prisma.errand.update({
      where: { id: errandId },
      data: { status: "ACCEPTED", acceptedAt: new Date() },
    });
    await this.excludedDriversStore.clear("errand", errandId);
    this.locationGateway.emitToUser(errand.requesterId, "errand:accepted", { errandId, driverId });
    return updated;
  }

  async declineOffer(driverId: string, errandId: string) {
    const errand = await this.getErrandOr404(errandId);
    if (errand.status !== "MATCHING" || errand.driverId !== driverId) {
      throw new ForbiddenException("This errand is not awaiting your response");
    }
    await this.handleDeclineOrTimeout(errandId, driverId);
    return { message: "Declined — offering to the next driver" };
  }

  async startShopping(driverId: string, errandId: string) {
    const errand = await this.getErrandOr404(errandId);
    this.assertDriverOwnsErrand(errand, driverId, ["ACCEPTED"]);
    const updated = await this.prisma.errand.update({ where: { id: errandId }, data: { status: "SHOPPING" } });
    this.locationGateway.emitToUser(errand.requesterId, "errand:shopping", { errandId });
    return updated;
  }

  async markOnTheWay(driverId: string, errandId: string, actualSpend: number) {
    const errand = await this.getErrandOr404(errandId);
    this.assertDriverOwnsErrand(errand, driverId, ["SHOPPING"]);
    const updated = await this.prisma.errand.update({
      where: { id: errandId },
      data: { status: "ON_THE_WAY", actualSpend },
    });
    this.locationGateway.emitToUser(errand.requesterId, "errand:onTheWay", { errandId, actualSpend });
    return updated;
  }

  async markDelivered(driverId: string, errandId: string) {
    const errand = await this.getErrandOr404(errandId);
    this.assertDriverOwnsErrand(errand, driverId, ["ON_THE_WAY"]);
    const updated = await this.prisma.errand.update({
      where: { id: errandId },
      data: { status: "DELIVERED", deliveredAt: new Date() },
    });
    this.locationGateway.emitToUser(errand.requesterId, "errand:delivered", { errandId });

    await this.ledgerService.recordErrandPayout(driverId, errandId, errand.serviceFee);
    await this.loyaltyService.awardDeliveryCompletionPoints(errand.requesterId);

    return updated;
  }

  async cancelErrand(errandId: string, userId: string) {
    const errand = await this.getErrandOr404(errandId);
    if (errand.requesterId !== userId && errand.driverId !== userId) {
      throw new ForbiddenException("Not your errand");
    }
    if (!["REQUESTED", "MATCHING", "ACCEPTED"].includes(errand.status)) {
      throw new BadRequestException(`Cannot cancel an errand that is ${errand.status}`);
    }
    const updated = await this.prisma.errand.update({
      where: { id: errandId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    await this.excludedDriversStore.clear("errand", errandId);
    return updated;
  }

  async getErrand(errandId: string) {
    return this.getErrandOr404(errandId);
  }

  async listMine(userId: string) {
    return this.prisma.errand.findMany({
      where: { OR: [{ requesterId: userId }, { driverId: userId }] },
      orderBy: { requestedAt: "desc" },
    });
  }

  private async getErrandOr404(errandId: string) {
    const errand = await this.prisma.errand.findUnique({ where: { id: errandId } });
    if (!errand) throw new NotFoundException("Errand not found");
    return errand;
  }

  private assertDriverOwnsErrand(errand: { driverId: string | null; status: string }, driverId: string, allowedStatuses: string[]) {
    if (errand.driverId !== driverId) throw new ForbiddenException("Not your errand");
    if (!allowedStatuses.includes(errand.status)) {
      throw new BadRequestException(`Errand must be ${allowedStatuses.join(" or ")}, currently ${errand.status}`);
    }
  }
}
