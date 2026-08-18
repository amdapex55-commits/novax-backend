import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

interface RateInput {
  raterId: string;
  rateeId: string;
  score: number;
  comment?: string;
  tripId?: string;
  deliveryId?: string;
  foodOrderId?: string;
}

@Injectable()
export class RatingsService {
  constructor(private prisma: PrismaService) {}

  async rate(input: RateInput) {
    if (input.raterId === input.rateeId) {
      throw new BadRequestException("Cannot rate yourself");
    }

    try {
      await this.prisma.rating.create({
        data: {
          raterId: input.raterId,
          rateeId: input.rateeId,
          score: input.score,
          comment: input.comment,
          tripId: input.tripId,
          deliveryId: input.deliveryId,
          foodOrderId: input.foodOrderId,
        },
      });
    } catch (err: any) {
      // Rating.tripId/deliveryId/foodOrderId are all @unique — a second
      // rating attempt on the same trip/delivery/order hits that constraint.
      // Turn Prisma's raw P2002 into a clear 400 instead of leaking a
      // database error.
      if (err?.code === "P2002") {
        throw new BadRequestException("This has already been rated");
      }
      throw err;
    }

    return this.recalculateAverage(input.rateeId);
  }

  /**
   * The reviews someone has actually received.
   *
   * The average was written to User.rating and shown as a number, and the
   * comments behind it were reachable by nothing — no endpoint, no screen. A
   * rider could see they were a 4.6 and never learn that three people had
   * written "kept me waiting". A score with no reasons attached cannot be
   * acted on, which makes it decoration.
   *
   * The rater is deliberately anonymous. A passenger who names a problem
   * should not be identifiable to the rider they named it about.
   */
  async listFor(userId: string, take = 30) {
    const [rows, agg] = await Promise.all([
      this.prisma.rating.findMany({
        where: { rateeId: userId },
        orderBy: { createdAt: "desc" },
        take: Math.min(take, 100),
        select: { score: true, comment: true, createdAt: true },
      }),
      this.prisma.rating.aggregate({
        where: { rateeId: userId },
        _avg: { score: true },
        _count: { score: true },
      }),
    ]);

    // How the score is made up, so a 4.6 is legible rather than mysterious.
    const breakdown = [5, 4, 3, 2, 1].map((star) => ({
      star,
      count: rows.filter((r) => r.score === star).length,
    }));

    return {
      average: agg._avg.score != null ? Math.round(agg._avg.score * 100) / 100 : null,
      total: agg._count.score,
      breakdown,
      reviews: rows.filter((r) => r.comment),
    };
  }

  private async recalculateAverage(userId: string) {
    const result = await this.prisma.rating.aggregate({
      where: { rateeId: userId },
      _avg: { score: true },
    });
    const average = result._avg.score ?? 5.0;
    return this.prisma.user.update({
      where: { id: userId },
      data: { rating: Math.round(average * 100) / 100 },
      select: { id: true, rating: true },
    });
  }
}
