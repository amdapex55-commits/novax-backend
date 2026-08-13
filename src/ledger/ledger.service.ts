import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { splitFare } from "./commission.util";
import { DRIVER_CREDIT_LIMIT_PKR } from "../location/location.service";

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private prisma: PrismaService) {}

  async recordTripPayout(
    driverId: string,
    tripId: string,
    fare: number | { toString(): string },
    tipAmount?: number | { toString(): string } | null,
  ) {
    const split = splitFare(fare);
    const tip = tipAmount != null ? Number(tipAmount) : 0;

    const payout = this.prisma.ledgerEntry.create({
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

    if (!(tip > 0)) return payout;

    // The tip is its own entry with commissionRate 0 and net === gross. Two
    // reasons it isn't just added to the payout's netAmount: the driver can
    // see on their statement that the tip reached them untouched, and the
    // 15% commission demonstrably never applies to it.
    //
    // Both rows describe one event (a trip completing), so they commit
    // together — same reasoning as recordDeliveryPayout below.
    const [entry] = await this.prisma.$transaction([
      payout,
      this.prisma.ledgerEntry.create({
        data: {
          userId: driverId,
          type: "TRIP_TIP",
          tripId,
          grossAmount: tip,
          commissionRate: 0,
          commissionAmount: 0,
          netAmount: tip,
        },
      }),
    ]);
    return entry;
  }

  /** Two ledger entries (driver payout + COD liability) describe ONE real
   * event — a delivery being marked delivered. They must land together or
   * not at all: Promise.all() fires both requests concurrently but a crash
   * between the two resolving can leave just one committed, silently
   * understating (or overstating) what the platform owes this driver.
   * prisma.$transaction() wraps them in a single DB transaction instead. */
  async recordDeliveryPayout(
    driverId: string,
    deliveryId: string,
    fare: number | { toString(): string },
    codAmount?: number | { toString(): string } | null,
    senderId?: string | null,
  ) {
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

      // The other half of that COD, which was missing entirely: the money the
      // recipient just handed the driver belongs to the SENDER, and until now
      // nothing credited them with it. The driver was correctly debited and
      // the sender was owed by nobody.
      //
      // Crediting it here is what removes the return trip. Without it the
      // driver has to ride back to the shop to hand over cash, which doubles
      // the distance of every COD parcel and destroys the unit economics. The
      // sender sees the balance immediately and withdraws it separately; the
      // cash itself reaches us through the driver's wallet top-up.
      if (senderId) {
        ops.push(
          this.prisma.ledgerEntry.create({
            data: {
              userId: senderId,
              type: "PARCEL_COD_CREDIT",
              deliveryId,
              grossAmount: codNumber,
              netAmount: codNumber,
            },
          }),
        );
      } else {
        // Loud, because a COD parcel with no sender recorded means somebody's
        // money is sitting in a driver's pocket with no ledger claim on it.
        this.logger.error(
          `COD delivery ${deliveryId} settled with no senderId — Rs ${codNumber} is unattributed. This needs manual reconciliation.`,
        );
      }
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
   * Nova Go launches CASH-ONLY: riders pay drivers cash, parcels/food are COD.
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

  /**
   * Cash out a positive balance — how a sender actually receives their COD money.
   *
   * The COD credit lands the moment the recipient pays the driver, so the
   * driver never rides back to the shop. This is the other end: the sender
   * turns that balance into real money in their JazzCash / Easypaisa / bank
   * account.
   *
   * The ledger row is written immediately and the balance drops immediately,
   * which is deliberate — it stops the same balance being withdrawn twice
   * while a payout is being processed by hand. Actually sending the money is
   * an ops action today; when a disbursement API is wired up, it becomes the
   * second half of this method rather than a new flow.
   */
  async requestWithdrawal(userId: string, amount: number, destination: string) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException("Enter an amount greater than zero");
    }
    const { balance } = await this.getBalance(userId);
    if (amount > balance) {
      throw new BadRequestException(
        `You can withdraw up to ${balance.toFixed(2)}. Requested ${amount.toFixed(2)}.`,
      );
    }

    const entry = await this.prisma.ledgerEntry.create({
      data: {
        userId,
        type: "WALLET_WITHDRAWAL",
        grossAmount: amount,
        // Negative: the platform no longer owes them this once it's paid out.
        netAmount: -amount,
      },
    });

    this.logger.log(
      `Withdrawal requested: user ${userId}, ${amount.toFixed(2)} to ${destination}. Entry ${entry.id} — pay this out manually.`,
    );
    return {
      ...entry,
      message: "Withdrawal requested. It'll reach your account within one working day.",
    };
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
    const balance = result._sum.netAmount ? Number(result._sum.netAmount) : 0;
    // The driver app needs all three to explain itself. Showing a bare
    // negative number without the limit next to it tells a driver they're in
    // trouble without telling them how much trouble, or what clears it.
    return {
      userId,
      balance,
      creditLimit: DRIVER_CREDIT_LIMIT_PKR === 0 ? null : -DRIVER_CREDIT_LIMIT_PKR,
      // True = not being offered work until they settle (enforced in
      // LocationService.filterEligible, off the same sum as this balance).
      blocked: DRIVER_CREDIT_LIMIT_PKR !== 0 && balance <= -DRIVER_CREDIT_LIMIT_PKR,
      amountToSettle:
        DRIVER_CREDIT_LIMIT_PKR !== 0 && balance <= -DRIVER_CREDIT_LIMIT_PKR
          ? Math.abs(balance)
          : 0,
    };
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

    /* THE LAST 14 DAYS, ROW BY ROW.
       The screen needs two things this aggregate cannot give it: a bar per
       day for the current week, and last week's total to compare against.
       Both are answerable from the same set of rows, so they are fetched
       once rather than as eight more aggregate queries.

       Reading rows instead of grouping in SQL is deliberate at this size: a
       busy driver does perhaps 25 jobs a day, so a fortnight is a few hundred
       small rows on an indexed range — cheaper than the round trips, and it
       keeps the day bucketing in one place. If a driver ever does thousands
       of jobs a week this should become a GROUP BY date_trunc. */
    const startOfLastWeek = new Date(startOfWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

    const [today, week, todayCount, weekCount, balance, recentRows] = await Promise.all([
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
      this.prisma.ledgerEntry.findMany({
        where: { userId, type: { in: PAYOUT_TYPES }, createdAt: { gte: startOfLastWeek } },
        select: { netAmount: true, createdAt: true },
      }),
    ]);

    // One bucket per day of the current week, Sunday first, so the client can
    // render seven bars without knowing anything about dates.
    const daily = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(startOfWeek);
      day.setDate(day.getDate() + i);
      return { date: day.toISOString().slice(0, 10), amount: 0, jobs: 0 };
    });

    let lastWeekTotal = 0;
    for (const row of recentRows) {
      const amount = Number(row.netAmount);
      if (row.createdAt < startOfWeek) { lastWeekTotal += amount; continue; }
      const idx = Math.floor((row.createdAt.getTime() - startOfWeek.getTime()) / 86_400_000);
      if (idx >= 0 && idx < 7) { daily[idx].amount += amount; daily[idx].jobs += 1; }
    }

    return {
      today: today._sum.netAmount ? Number(today._sum.netAmount) : 0,
      week: week._sum.netAmount ? Number(week._sum.netAmount) : 0,
      jobsToday: todayCount,
      jobsThisWeek: weekCount,
      balance: balance.balance,
      daily,
      lastWeek: lastWeekTotal,
      // Which bucket is today, so the client can highlight it without
      // re-deriving the week boundary in a different timezone to the server.
      todayIndex: Math.floor((startOfDay.getTime() - startOfWeek.getTime()) / 86_400_000),
    };
  }
}
