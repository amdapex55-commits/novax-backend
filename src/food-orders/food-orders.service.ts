import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LocationService } from "../location/location.service";
import { LocationGateway } from "../location/location.gateway";
import { ExcludedDriversStore } from "../location/excluded-drivers.store";
import { LedgerService } from "../ledger/ledger.service";
import { RatingsService } from "../ratings/ratings.service";
import { LoyaltyService } from "../loyalty/loyalty.service";
import { NotificationsService } from "../notifications/notifications.service";
import { CreateFoodOrderDto } from "./dto/create-food-order.dto";
import { estimateFare, haversineKm } from "../trips/fare.util";

// Same expanding-radius cascade shape as TripsService/DeliveryService, just
// scoped to drivers currently toggled into FOOD_ERRAND mode.
const SEARCH_RADII_KM = [1, 3, 5, 8];
const OFFER_TIMEOUT_MS = 15_000;

@Injectable()
export class FoodOrdersService {
  private readonly logger = new Logger(FoodOrdersService.name);

  constructor(
    private prisma: PrismaService,
    private locationService: LocationService,
    private locationGateway: LocationGateway,
    private excludedDriversStore: ExcludedDriversStore,
    private ledgerService: LedgerService,
    private ratingsService: RatingsService,
    private loyaltyService: LoyaltyService,
    private notificationsService: NotificationsService,
  ) {}

  async createOrder(customerId: string, dto: CreateFoodOrderDto) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: dto.restaurantId } });
    if (!restaurant || restaurant.status !== "APPROVED") throw new NotFoundException("Restaurant not found");
    if (!restaurant.isOpen) throw new BadRequestException("This restaurant is currently closed");

    const menuItemIds = dto.items.map((i) => i.menuItemId);
    const menuItems = await this.prisma.menuItem.findMany({
      where: { id: { in: menuItemIds }, restaurantId: restaurant.id },
    });
    if (menuItems.length !== new Set(menuItemIds).size) {
      throw new BadRequestException("One or more menu items don't belong to this restaurant");
    }

    // menuItem.price is a Prisma Decimal column now — Number() it before any
    // arithmetic (Decimal instances don't support the `*` operator).
    let itemsTotal = 0;
    const orderItemsData = dto.items.map((input) => {
      const menuItem = menuItems.find((m) => m.id === input.menuItemId)!;
      if (!menuItem.isAvailable) throw new BadRequestException(`${menuItem.name} is currently unavailable`);
      const unitPrice = Number(menuItem.price);
      const subtotal = Math.round(unitPrice * input.quantity * 100) / 100;
      itemsTotal += subtotal;
      return {
        menuItemId: menuItem.id,
        nameSnapshot: menuItem.name,
        priceSnapshot: unitPrice,
        quantity: input.quantity,
        subtotal,
      };
    });

    const distanceKm = haversineKm(restaurant.lat, restaurant.lng, dto.dropoffLat, dto.dropoffLng);
    const deliveryFee = estimateFare("FOOD", distanceKm);
    const total = Math.round((itemsTotal + deliveryFee) * 100) / 100;

    const order = await this.prisma.foodOrder.create({
      data: {
        customerId,
        restaurantId: restaurant.id,
        dropoffLabel: dto.dropoffLabel,
        dropoffLat: dto.dropoffLat,
        dropoffLng: dto.dropoffLng,
        notes: dto.notes,
        itemsTotal,
        deliveryFee,
        total,
        items: { create: orderItemsData },
      },
      include: { items: true },
    });

    await this.notificationsService.create(
      restaurant.ownerId,
      "New order received",
      `A new order (Rs. ${total.toFixed(0)}) just came in — accept it to start preparing.`,
    );
    this.locationGateway.emitToUser(restaurant.ownerId, "foodOrder:new", { orderId: order.id });

    return order;
  }

  async listMenuForRestaurant(restaurantId: string) {
    return this.prisma.menuItem.findMany({ where: { restaurantId, isAvailable: true } });
  }

  // ---- Restaurant-side lifecycle ----

  async listRestaurantOrders(ownerId: string) {
    const restaurant = await this.getOwnedRestaurantOr404(ownerId);
    return this.prisma.foodOrder.findMany({
      where: { restaurantId: restaurant.id },
      include: { items: true },
      orderBy: { placedAt: "desc" },
    });
  }

  async acceptOrder(ownerId: string, orderId: string) {
    const order = await this.getRestaurantOwnedOrderOr404(ownerId, orderId);
    if (order.status !== "PLACED") throw new BadRequestException(`Order must be PLACED, currently ${order.status}`);
    const updated = await this.prisma.foodOrder.update({
      where: { id: orderId },
      data: { status: "ACCEPTED", acceptedAt: new Date() },
    });
    this.locationGateway.emitToUser(order.customerId, "foodOrder:accepted", { orderId });
    return updated;
  }

  async markReady(ownerId: string, orderId: string) {
    const order = await this.getRestaurantOwnedOrderOr404(ownerId, orderId);
    if (order.status !== "ACCEPTED") throw new BadRequestException(`Order must be ACCEPTED, currently ${order.status}`);
    const updated = await this.prisma.foodOrder.update({
      where: { id: orderId },
      data: { status: "READY", readyAt: new Date() },
    });
    this.locationGateway.emitToUser(order.customerId, "foodOrder:ready", { orderId });
    this.attemptMatch(orderId).catch((err) => this.logger.error(`Matching failed for food order ${orderId}`, err));
    return updated;
  }

  private async attemptMatch(orderId: string) {
    const order = await this.prisma.foodOrder.findUnique({ where: { id: orderId }, include: { restaurant: true } });
    if (!order || (order.status !== "READY" && order.status !== "MATCHING")) return;

    const excluded = await this.excludedDriversStore.getAll("foodOrder", orderId);

    for (const radius of SEARCH_RADII_KM) {
      /* Segregation ran for trips only — see the note in delivery.service.ts.
         A review-fleet food order was being dispatched to real drivers. */
      const nearby = await this.locationService.findNearbyDriversForMode(
        order.restaurant.lat,
        order.restaurant.lng,
        radius,
        "FOOD_ERRAND",
        await this.isTestFleetJob(order.customerId),
      );
      const candidate = nearby.find((d) => !excluded.has(d.driverId));
      if (candidate) {
        await this.offerToDriver(orderId, candidate.driverId);
        return;
      }
    }
    this.logger.warn(`No available FOOD_ERRAND drivers found for food order ${orderId}`);
  }

  /** Whose fleet this job belongs to, read from the customer's account. */
  private async isTestFleetJob(ownerId: string): Promise<boolean> {
    const u = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { isTestAccount: true } });
    return u?.isTestAccount === true;
  }

  private async offerToDriver(orderId: string, driverId: string) {
    await this.prisma.foodOrder.update({ where: { id: orderId }, data: { status: "MATCHING", driverId } });
    this.locationGateway.emitToUser(driverId, "foodOrder:offer", { orderId, expiresInMs: OFFER_TIMEOUT_MS });

    setTimeout(async () => {
      const current = await this.prisma.foodOrder.findUnique({ where: { id: orderId } });
      if (current?.status === "MATCHING" && current.driverId === driverId) {
        await this.handleDeclineOrTimeout(orderId, driverId);
      }
    }, OFFER_TIMEOUT_MS);
  }

  private async handleDeclineOrTimeout(orderId: string, driverId: string) {
    await this.excludedDriversStore.add("foodOrder", orderId, driverId);
    await this.prisma.foodOrder.update({ where: { id: orderId }, data: { status: "READY", driverId: null } });
    await this.attemptMatch(orderId);
  }

  // ---- Driver-side lifecycle ----

  async acceptOffer(driverId: string, orderId: string) {
    // Atomic claim — see the note in TripsService.acceptTrip().
    const claimed = await this.prisma.foodOrder.updateMany({
      where: { id: orderId, status: "MATCHING", driverId },
      data: { status: "ASSIGNED" },
    });
    if (claimed.count === 0) {
      throw new ForbiddenException("This order is not awaiting your response");
    }
    const order = await this.getOrderOr404(orderId);
    const updated = order;
    await this.excludedDriversStore.clear("foodOrder", orderId);
    this.locationGateway.emitToUser(order.customerId, "foodOrder:assigned", { orderId, driverId });
    return updated;
  }

  async declineOffer(driverId: string, orderId: string) {
    const order = await this.getOrderOr404(orderId);
    if (order.status !== "MATCHING" || order.driverId !== driverId) {
      throw new ForbiddenException("This order is not awaiting your response");
    }
    await this.handleDeclineOrTimeout(orderId, driverId);
    return { message: "Declined — offering to the next driver" };
  }

  async markPickedUp(driverId: string, orderId: string) {
    const order = await this.getOrderOr404(orderId);
    this.assertDriverOwnsOrder(order, driverId, ["ASSIGNED"]);
    const updated = await this.prisma.foodOrder.update({
      where: { id: orderId },
      data: { status: "PICKED_UP", pickedUpAt: new Date() },
    });
    this.locationGateway.emitToUser(order.customerId, "foodOrder:pickedUp", { orderId });
    return updated;
  }

  async markDelivered(driverId: string, orderId: string) {
    const order = await this.getOrderOr404(orderId);
    this.assertDriverOwnsOrder(order, driverId, ["PICKED_UP"]);

    // Conditional transition so a retry can't double-pay the driver AND the
    // restaurant — see TripsService.completeTrip for the full reasoning.
    const claimed = await this.prisma.foodOrder.updateMany({
      where: { id: orderId, status: "PICKED_UP" },
      data: { status: "DELIVERED", deliveredAt: new Date() },
    });
    if (claimed.count === 0) return this.getOrderOr404(orderId);
    const updated = await this.getOrderOr404(orderId);
    this.locationGateway.emitToUser(order.customerId, "foodOrder:delivered", { orderId });

    // Driver payout + restaurant payout must land together — see
    // LedgerService.recordFoodOrderPayouts's comment for why this is one
    // $transaction call instead of two separate awaits.
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: order.restaurantId } });
    if (restaurant) {
      await this.ledgerService.recordFoodOrderPayouts({
        driverId,
        restaurantOwnerId: restaurant.ownerId,
        foodOrderId: orderId,
        deliveryFee: order.deliveryFee,
        itemsTotal: order.itemsTotal,
        restaurantCommissionRate: restaurant.commissionRate,
      });
    }
    await this.loyaltyService.awardDeliveryCompletionPoints(order.customerId);

    return updated;
  }

  async cancelOrder(orderId: string, userId: string) {
    const order = await this.getOrderOr404(orderId);
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: order.restaurantId } });
    const isParty = order.customerId === userId || order.driverId === userId || restaurant?.ownerId === userId;
    if (!isParty) throw new ForbiddenException("Not your order");
    if (!["PLACED", "ACCEPTED", "READY", "MATCHING"].includes(order.status)) {
      throw new BadRequestException(`Cannot cancel an order that is ${order.status}`);
    }
    const updated = await this.prisma.foodOrder.update({
      where: { id: orderId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    await this.excludedDriversStore.clear("foodOrder", orderId);
    return updated;
  }

  async rateOrder(orderId: string, raterId: string, score: number, comment?: string) {
    const order = await this.getOrderOr404(orderId);
    if (order.customerId !== raterId) throw new ForbiddenException("Only the customer can rate this order");
    if (order.status !== "DELIVERED") throw new BadRequestException("Can only rate a delivered order");
    if (!order.driverId) throw new BadRequestException("This order has no driver to rate");
    return this.ratingsService.rate({ raterId, rateeId: order.driverId, score, comment, foodOrderId: orderId });
  }

  // Includes restaurant (name + pickup lat/lng) so the driver progress
  // screen can show where to actually go, not just a generic "head to the
  // restaurant" with no address.
  //
  // Ownership-checked: customer, assigned driver, and the restaurant's own
  // owner are the three legitimate readers. Previously any logged-in user
  // could read any order (dropoff address + notes) by guessing an id.
  async getOrder(orderId: string, requesterId: string, requesterRole?: string) {
    const order = await this.prisma.foodOrder.findUnique({
      where: { id: orderId },
      include: { items: true, restaurant: { select: { ownerId: true, name: true, address: true, lat: true, lng: true } } },
    });
    if (!order) throw new NotFoundException("Order not found");
    const isParty =
      order.customerId === requesterId ||
      order.driverId === requesterId ||
      order.restaurant?.ownerId === requesterId;
    if (requesterRole !== "ADMIN" && !isParty) throw new ForbiddenException("Not your order");
    return order;
  }

  async listMine(userId: string) {
    return this.prisma.foodOrder.findMany({
      where: { OR: [{ customerId: userId }, { driverId: userId }] },
      include: { items: true },
      orderBy: { placedAt: "desc" },
    });
  }

  private async getOrderOr404(orderId: string) {
    const order = await this.prisma.foodOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  private async getOwnedRestaurantOr404(ownerId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { ownerId } });
    if (!restaurant) throw new NotFoundException("No restaurant registered for this account");
    return restaurant;
  }

  private async getRestaurantOwnedOrderOr404(ownerId: string, orderId: string) {
    const order = await this.getOrderOr404(orderId);
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: order.restaurantId } });
    if (!restaurant || restaurant.ownerId !== ownerId) throw new ForbiddenException("Not your order");
    return order;
  }

  private assertDriverOwnsOrder(order: { driverId: string | null; status: string }, driverId: string, allowedStatuses: string[]) {
    if (order.driverId !== driverId) throw new ForbiddenException("Not your order");
    if (!allowedStatuses.includes(order.status)) {
      throw new BadRequestException(`Order must be ${allowedStatuses.join(" or ")}, currently ${order.status}`);
    }
  }
}
