import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { splitFare } from "./commission.util";

@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService) {}

  async recordTripPayout(driverId: string, tripId: string, fare: number) {
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

  async recordDeliveryPayout(driverId: string, deliveryId: string, fare: number, codAmount?: number | null) {
    const split = splitFare(fare);
    const entries = [
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
    if (codAmount && codAmount > 0) {
      entries.push(
        this.prisma.ledgerEntry.create({
          data: {
            userId: driverId,
            type: "DELIVERY_COD_LIABILITY",
            deliveryId,
            grossAmount: codAmount,
            netAmount: -codAmount,
          },
        }),
      );
    }

    return Promise.all(entries);
  }

  /** Running balance = sum of every ledger entry's netAmount for this user.
   * Positive means the platform owes them; negative means they owe the
   * platform (e.g. COD cash not yet remitted exceeds unpaid trip payouts). */
  async getBalance(userId: string) {
    const result = await this.prisma.ledgerEntry.aggregate({
      where: { userId },
      _sum: { netAmount: true },
    });
    return { userId, balance: result._sum.netAmount ?? 0 };
  }

  async getHistory(userId: string) {
    return this.prisma.ledgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }
}
