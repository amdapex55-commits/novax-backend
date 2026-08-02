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
