import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { splitFare } from "./commission.util";

@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService) {}

  async recordTripPayout(driverId: string, tripId: string, fare: number | { toString(): string }) {
    const split = splitFare(fare);
    return this.prisma.ledgerEntry.create({
      data: {
        userId: driverId,
        type: "TRIP_PAYOUT",
        tripId,
        grossAmount: split.grossAmount,
        commissionRate: split.commissionRate,
        commissionAmount: split.commissionAmount,
        netAmount: split.netAmount,
      },
    });
  }

  /** Two ledger entries (driver payout + COD liability) describe ONE real
   * event — a delivery being marked delivered. They must land together or
   * not at all: Promise.all() fires both requests concurrently but a crash
   * between the two resolving can leave just one committed, silently
   * understating (or overstating) what the platform owes this driver.
   * prisma.$transaction() wraps them in a single DB transaction instead. */
  async recordDeliveryPayout(driverId: string, deliveryId: string, fare: number | { toString(): string }, codAmount?: number | { toString(): string } | null) {
    const split = splitFare(fare);
    const codNumber = codAmount != null ? Number(codAmount) : null;

    const ops = [
      this.prisma.ledgerEntry.create({
        data: {
          userId: driverId,
          type: "DELIVERY_PAYOUT",
          deliveryId,
          grossAmount: split.grossAmount,
          commissionRate: split.commissionRate,
          commissionAmount: split.commissionAmount,
          netAmount: split.netAmount,
        },
      }),
    ];

    // COD cash is the recipient's money, handed to the driver, owed to
    // whoever the sender is settling with — record it as a liability
    // (negative netAmount) so it nets against the driver's payout instead of
    // silently becoming "extra" money in their running balance.
    if (codNumber && codNumber > 0) {
      ops.push(
        this.prisma.ledgerEntry.create({
          data: {
            userId: driverId,
            type: "DELIVERY_COD_LIABILITY",
            deliveryId,
            grossAmount: codNumber,
            netAmount: -codNumber,
          },
        }),
      );
    }

    return this.prisma.$transaction(ops);
  }

  /** A food order's completion pays out TWO different parties — the driver
   * (delivery fee) and the restaurant (items total minus the restaurant's
   * own commission rate) — from two different pools of money. Same
   * all-or-nothing requirement as recordDeliveryPayout: both entries commit
   * together in one transaction, never just one. */
  async recordFoodOrderPayouts(params: {
    driverId: string;
    restaurantOwnerId: string;
    foodOrderId: string;
    deliveryFee: number | { toString(): string };
    itemsTotal: number | { toString(): string };
    restaurantCommissionRate: number;
  }) {
    const driverSplit = splitFare(params.deliveryFee);
    const restaurantSplit = splitFare(params.itemsTotal, params.restaurantCommissionRate);

    return this.prisma.$transaction([
      this.prisma.ledgerEntry.create({
        data: {
          userId: params.driverId,
          type: "FOOD_ORDER_DRIVER_PAYOUT",
          foodOrderId: params.foodOrderId,
          grossAmount: driverSplit.grossAmount,
          commissionRate: driverSplit.commissionRate,
          commissionAmount: driverSplit.commissionAmount,
          netAmount: driverSplit.netAmount,
        },
      }),
      this.prisma.ledgerEntry.create({
        data: {
          userId: params.restaurantOwnerId,
          type: "FOOD_ORDER_RESTAURANT_PAYOUT",
          foodOrderId: params.foodOrderId,
          grossAmount: restaurantSplit.grossAmount,
          commissionRate: restaurantSplit.commissionRate,
          commissionAmount: restaurantSplit.commissionAmount,
          netAmount: restaurantSplit.netAmount,
        },
      }),
    ]);
  }

  async recordErrandPayout(driverId: string, errandId: string, serviceFee: number | { toString(): string }) {
    const split = splitFare(serviceFee);
    return this.prisma.ledgerEntry.create({
      data: {
        userId: driverId,
        type: "ERRAND_PAYOUT",
        errandId,
        grossAmount: split.grossAmount,
        commissionRate: split.commissionRate,
        commissionAmount: split.commissionAmount,
        netAmount: split.netAmount,
      },
    });
  }

  /** ADMIN-ONLY manual credit (see wallet.controller.ts).
   *
   * Nova X launches CASH-ONLY: riders pay drivers cash, parcels/food are COD.
   * There is no consumer top-up, because there's no payment gateway — and an
   * endpoint that mints balance without one is just free money.
   *
   * What this is for: an ops person issuing a refund, a goodwill credit, or
   * recording a driver payout that was settled outside the app. Every call
   * is a deliberate human action from the ops dashboard, and lands as a real
   * ledger row with an audit trail. When a real gateway does get wired up,
   * its verified webhook becomes a second caller of this same method. */
  async topUp(userId: string, amount: number) {
    return this.prisma.ledgerEntry.create({
      data: {
        userId,
        type: "WALLET_TOPUP",
        grossAmount: amount,
        netAmount: amount,
      },
    });
  }

  /** Running balance = sum of every ledger entry's netAmount for this user.
   * Positive means the platform owes them; negative means they owe the
   * platform (e.g. COD cash not yet remitted exceeds unpaid trip payouts). */
  async getBalance(userId: string) {
    const result = await this.prisma.ledgerEntry.aggregate({
      where: { userId },
      _sum: { netAmount: true },
    });
    // _sum on a Decimal column comes back as a Decimal (or null with zero
    // rows), not a plain number — Number() here for the same reason as
    // commission.util.ts's splitFare().
    return { userId, balance: result._sum.netAmount ? Number(result._sum.netAmount) : 0 };
  }

  async getHistory(userId: string) {
    return this.prisma.ledgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * The driver home screen's hero card: what have I made today, and this
   * week? Drivers open the app to see this number — it deserves a real
   * query rather than the hardcoded "Rs. 0" the screen used to show.
   *
   * Counts payout entries only (positive earnings), not COD liabilities,
   * which would otherwise make a busy cash day look like a loss.
   */
  async getDriverEarnings(userId: string) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

    const PAYOUT_TYPES = [
      "TRIP_PAYOUT",
      "DELIVERY_PAYOUT",
      "FOOD_ORDER_DRIVER_PAYOUT",
      "ERRAND_PAYOUT",
    ] as any;

    const [today, week, todayCount, weekCount, balance] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({
        where: { userId, type: { in: PAYOUT_TYPES }, createdAt: { gte: startOfDay } },
        _sum: { netAmount: true },
      }),
      this.prisma.ledgerEntry.aggregate({
        where: { userId, type: { in: PAYOUT_TYPES }, createdAt: { gte: startOfWeek } },
        _sum: { netAmount: true },
      }),
      this.prisma.ledgerEntry.count({
        where: { userId, type: { in: PAYOUT_TYPES }, createdAt: { gte: startOfDay } },
      }),
      this.prisma.ledgerEntry.count({
        where: { userId, type: { in: PAYOUT_TYPES }, createdAt: { gte: startOfWeek } },
      }),
      this.getBalance(userId),
    ]);

    return {
      today: today._sum.netAmount ? Number(today._sum.netAmount) : 0,
      week: week._sum.netAmount ? Number(week._sum.netAmount) : 0,
      jobsToday: todayCount,
      jobsThisWeek: weekCount,
      balance: balance.balance,
    };
  }
}
