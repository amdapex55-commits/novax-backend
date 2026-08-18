import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LocationService } from "../location/location.service";
import { LocationGateway } from "../location/location.gateway";
import { ExcludedDriversStore } from "../location/excluded-drivers.store";
import { LedgerService } from "../ledger/ledger.service";
import { RatingsService } from "../ratings/ratings.service";
import { LoyaltyService } from "../loyalty/loyalty.service";
import { CreateDeliveryDto } from "./dto/create-delivery.dto";
import { estimateFare, haversineKm } from "../trips/fare.util";

// Deliberately mirrors TripsService's matching logic (expanding-radius search,
// timed offer, auto-cascade on decline) rather than sharing a base class with
// it — Trips is now proven in Phase 2, and refactoring it to share code with
// a brand-new module is exactly the kind of change that reintroduces the bugs
// we just fixed. If the two drift in a way that's genuinely annoying to
// maintain, extract a shared DispatchService then — not speculatively now.
const SEARCH_RADII_KM = [1, 3, 5, 8];
const OFFER_TIMEOUT_MS = 15_000;

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private prisma: PrismaService,
    private locationService: LocationService,
    private locationGateway: LocationGateway,
    private excludedDriversStore: ExcludedDriversStore,
    private ledgerService: LedgerService,
    private ratingsService: RatingsService,
    private loyaltyService: LoyaltyService,
  ) {}

  async createDelivery(senderId: string, dto: CreateDeliveryDto) {
    const distanceKm = haversineKm(dto.pickupLat, dto.pickupLng, dto.dropoffLat, dto.dropoffLng);
    const fare = estimateFare("PARCEL", distanceKm);

    const delivery = await this.prisma.delivery.create({
      data: {
        senderId,
        pickupLat: dto.pickupLat,
        pickupLng: dto.pickupLng,
        dropoffLat: dto.dropoffLat,
        dropoffLng: dto.dropoffLng,
        pickupLabel: dto.pickupLabel,
        dropoffLabel: dto.dropoffLabel,
        recipientName: dto.recipientName,
        recipientPhone: dto.recipientPhone,
        parcelNote: dto.parcelNote,
        codAmount: dto.codAmount,
        distanceKm,
        fare,
      },
    });

    this.attemptMatch(delivery.id).catch((err) =>
      this.logger.error(`Matching failed for delivery ${delivery.id}`, err),
    );

    return delivery;
  }

  private async attemptMatch(deliveryId: string) {
    const delivery = await this.prisma.delivery.findUnique({ where: { id: deliveryId } });
    if (!delivery || (delivery.status !== "REQUESTED" && delivery.status !== "MATCHING")) return;

    const excluded = await this.excludedDriversStore.getAll("delivery", deliveryId);

    for (const radius of SEARCH_RADII_KM) {
    /* SEGREGATION RAN FOR TRIPS ONLY.
       findNearbyDrivers takes a wantTestFleet flag and matches it exactly in
       both directions, but only trips ever passed it — deliveries, food
       orders and errands all fell through to the default of `false`. So a
       store reviewer's simulated parcel or food order was dispatched to a
       real driver on a real bike in Karachi, which is precisely the outcome
       the review fleet exists to prevent. The owner's account is the
       authority, the same source the trip's own isTest is stamped from. */
      const nearby = await this.locationService.findNearbyDrivers(
        delivery.pickupLat, delivery.pickupLng, radius, await this.isTestFleetJob(delivery.senderId));
      const candidate = nearby.find((d) => !excluded.has(d.driverId));
      if (candidate) {
        await this.offerToDriver(deliveryId, candidate.driverId);
        return;
      }
    }

    this.logger.warn(`No available drivers found for delivery ${deliveryId}`);
  }

  /** Whose fleet this job belongs to, read from the requester's account. */
  private async isTestFleetJob(ownerId: string): Promise<boolean> {
    const u = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { isTestAccount: true } });
    return u?.isTestAccount === true;
  }

  private async offerToDriver(deliveryId: string, driverId: string) {
    const delivery = await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "MATCHING", driverId },
    });

    /* THE OFFER USED TO CARRY ONLY AN ID.
       A driver was asked to accept a job in fifteen seconds without being told
       what it paid, how far it was, or — most importantly — whether they were
       expected to collect cash from the recipient. COD is the driver's own
       money at risk until they settle, so it is not a detail to discover after
       accepting. Everything needed to make the decision now rides with the
       offer, the same way it does for a ride. */
    this.locationGateway.emitToUser(driverId, "delivery:offer", {
      deliveryId,
      expiresInMs: OFFER_TIMEOUT_MS,
      fare: delivery.fare ? Number(delivery.fare) : null,
      codAmount: delivery.codAmount ? Number(delivery.codAmount) : null,
      distanceKm: delivery.distanceKm,
      recipientName: delivery.recipientName,
      parcelNote: delivery.parcelNote,
      pickupLabel: delivery.pickupLabel,
      dropoffLabel: delivery.dropoffLabel,
      pickupLat: delivery.pickupLat,
      pickupLng: delivery.pickupLng,
      dropoffLat: delivery.dropoffLat,
      dropoffLng: delivery.dropoffLng,
    });

    setTimeout(async () => {
      const current = await this.prisma.delivery.findUnique({ where: { id: deliveryId } });
      if (current?.status === "MATCHING" && current.driverId === driverId) {
        await this.handleDeclineOrTimeout(deliveryId, driverId);
      }
    }, OFFER_TIMEOUT_MS);
  }

  private async handleDeclineOrTimeout(deliveryId: string, driverId: string) {
    await this.excludedDriversStore.add("delivery", deliveryId, driverId);
    await this.prisma.delivery.update({ where: { id: deliveryId }, data: { status: "REQUESTED", driverId: null } });
    await this.attemptMatch(deliveryId);
  }

  async acceptDelivery(deliveryId: string, driverId: string) {
    // Atomic claim — see the note in TripsService.acceptTrip().
    const claimed = await this.prisma.delivery.updateMany({
      where: { id: deliveryId, status: "MATCHING", driverId },
      data: { status: "MATCHED", matchedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new ForbiddenException("This delivery is not awaiting your response");
    }
    const delivery = await this.getDeliveryOr404(deliveryId);
    const updated = delivery;
    await this.excludedDriversStore.clear("delivery", deliveryId);
    this.locationGateway.emitToUser(delivery.senderId, "delivery:matched", { deliveryId, driverId });
    return updated;
  }

  async declineDelivery(deliveryId: string, driverId: string) {
    const delivery = await this.getDeliveryOr404(deliveryId);
    if (delivery.status !== "MATCHING" || delivery.driverId !== driverId) {
      throw new ForbiddenException("This delivery is not awaiting your response");
    }
    await this.handleDeclineOrTimeout(deliveryId, driverId);
    return { message: "Declined — offering to the next driver" };
  }

  async markPickedUp(deliveryId: string, driverId: string) {
    const delivery = await this.getDeliveryOr404(deliveryId);
    this.assertDriverOwnsDelivery(delivery, driverId, ["MATCHED"]);
    const updated = await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "PICKED_UP", pickedUpAt: new Date() },
    });
    this.locationGateway.emitToUser(delivery.senderId, "delivery:pickedUp", { deliveryId });
    return updated;
  }

  async markInTransit(deliveryId: string, driverId: string) {
    const delivery = await this.getDeliveryOr404(deliveryId);
    this.assertDriverOwnsDelivery(delivery, driverId, ["PICKED_UP"]);
    const updated = await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "IN_TRANSIT" },
    });
    this.locationGateway.emitToUser(delivery.senderId, "delivery:inTransit", { deliveryId });
    return updated;
  }

  /** proofOfDeliveryUrl comes from a direct-to-R2 upload done client-side —
   * the driver app calls POST /api/v1/uploads/presign first, PUTs the photo,
   * then passes the resulting public URL in here. */
  async markDelivered(deliveryId: string, driverId: string, proofOfDeliveryUrl?: string) {
    const delivery = await this.getDeliveryOr404(deliveryId);
    this.assertDriverOwnsDelivery(delivery, driverId, ["PICKED_UP", "IN_TRANSIT"]);

    // Conditional transition so a retry can't double-pay — see the same
    // guard (and reasoning) in TripsService.completeTrip.
    const claimed = await this.prisma.delivery.updateMany({
      where: { id: deliveryId, status: { in: ["PICKED_UP", "IN_TRANSIT"] } },
      data: { status: "DELIVERED", deliveredAt: new Date(), proofOfDeliveryUrl },
    });
    if (claimed.count === 0) return this.getDeliveryOr404(deliveryId);
    const updated = await this.getDeliveryOr404(deliveryId);
    // delivery.fare/codAmount are Prisma Decimal columns — Number() before
    // they leave this function in a socket payload; the ledger call below
    // passes the Decimal straight through since recordDeliveryPayout does
    // its own Number() conversion internally (see commission.util.ts).
    this.locationGateway.emitToUser(delivery.senderId, "delivery:delivered", { deliveryId, fare: delivery.fare ? Number(delivery.fare) : null });

    if (delivery.fare) {
      await this.ledgerService.recordDeliveryPayout(driverId, deliveryId, delivery.fare, delivery.codAmount, delivery.senderId);
    }
    await this.loyaltyService.awardDeliveryCompletionPoints(delivery.senderId);

    return updated;
  }

  /** Sender rates the driver after a completed delivery. */
  async rateDelivery(deliveryId: string, raterId: string, score: number, comment?: string) {
    const delivery = await this.getDeliveryOr404(deliveryId);
    if (delivery.senderId !== raterId) throw new ForbiddenException("Only the sender can rate this delivery");
    if (delivery.status !== "DELIVERED") throw new BadRequestException("Can only rate a delivered parcel");
    if (!delivery.driverId) throw new BadRequestException("This delivery has no driver to rate");
    return this.ratingsService.rate({ raterId, rateeId: delivery.driverId, score, comment, deliveryId });
  }

  async cancelDelivery(deliveryId: string, userId: string) {
    const delivery = await this.getDeliveryOr404(deliveryId);
    if (delivery.senderId !== userId && delivery.driverId !== userId) {
      throw new ForbiddenException("Not your delivery");
    }
    if (!["REQUESTED", "MATCHING", "MATCHED"].includes(delivery.status)) {
      throw new BadRequestException(`Cannot cancel a delivery that is ${delivery.status}`);
    }
    const updated = await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    await this.excludedDriversStore.clear("delivery", deliveryId);
    const notify = delivery.senderId === userId ? delivery.driverId : delivery.senderId;
    if (notify) this.locationGateway.emitToUser(notify, "delivery:cancelled", { deliveryId });
    return updated;
  }

  // Ownership-checked — see the same note on TripsService.getTrip: a bare
  // JWT used to be enough to read any delivery (and its recipient name/
  // phone/COD amount) by guessing an id.
  async getDelivery(deliveryId: string, requesterId: string, requesterRole?: string) {
    const delivery = await this.getDeliveryOr404(deliveryId);
    if (requesterRole !== "ADMIN" && delivery.senderId !== requesterId && delivery.driverId !== requesterId) {
      throw new ForbiddenException("Not your delivery");
    }
    return delivery;
  }

  async listMyDeliveries(userId: string) {
    return this.prisma.delivery.findMany({
      where: { OR: [{ senderId: userId }, { driverId: userId }] },
      orderBy: { requestedAt: "desc" },
    });
  }

  private async getDeliveryOr404(deliveryId: string) {
    /* THE DRIVER COULD NOT PHONE THE PERSON HANDING OVER THE PARCEL.
       This returned the bare row, so the driver's job screen had a recipient
       name and number for the drop-off and nothing at all for the pickup —
       no name, no number. A parcel has two people; a ride has one, and this
       was written as though it had one. Only fields the counterparty may
       see: no CNIC, no payout details. */
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        sender: { select: { name: true, phone: true, rating: true } },
        driver: { select: { name: true, phone: true, rating: true } },
      },
    });
    if (!delivery) throw new NotFoundException("Delivery not found");
    return delivery;
  }

  private assertDriverOwnsDelivery(
    delivery: { driverId: string | null; status: string },
    driverId: string,
    allowedStatuses: string[],
  ) {
    if (delivery.driverId !== driverId) throw new ForbiddenException("Not your delivery");
    if (!allowedStatuses.includes(delivery.status)) {
      throw new BadRequestException(`Delivery must be ${allowedStatuses.join(" or ")}, currently ${delivery.status}`);
    }
  }
}
