import { Injectable } from "@nestjs/common";
import { randomInt } from "crypto";
import { PrismaService } from "../prisma/prisma.service";

// No ambiguous chars (0/O, 1/I) — these get read aloud / typed by hand.
const REFERRAL_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REFERRAL_LENGTH = 6;

const POINTS_PER_TRIP = 10;
const POINTS_PER_DELIVERY = 10;
const REFERRAL_BONUS_POINTS = 100;

const TIERS = [
  { name: "Bronze", min: 0 },
  { name: "Silver", min: 200 },
  { name: "Gold", min: 500 },
  { name: "Platinum", min: 1000 },
];

@Injectable()
export class LoyaltyService {
  constructor(private prisma: PrismaService) {}

  private generateCode(): string {
    let code = "";
    for (let i = 0; i < REFERRAL_LENGTH; i++) code += REFERRAL_CHARS[randomInt(0, REFERRAL_CHARS.length)];
    return code;
  }

  /** Every user should have a referral code, but the column is nullable
   * (see schema comment on User.referralCode) — generate + persist one the
   * first time anyone asks, retrying on the rare collision. */
  async ensureReferralCode(userId: string): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.referralCode) return user.referralCode;

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = this.generateCode();
      try {
        await this.prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
        return code;
      } catch (e: any) {
        if (e?.code === "P2002") continue; // collision — try another code
        throw e;
      }
    }
    throw new Error("Could not generate a unique referral code after 5 attempts");
  }

  async awardPoints(userId: string, points: number) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { loyaltyPoints: { increment: points } },
    });
  }

  awardTripCompletionPoints(riderId: string) {
    return this.awardPoints(riderId, POINTS_PER_TRIP);
  }

  awardDeliveryCompletionPoints(senderId: string) {
    return this.awardPoints(senderId, POINTS_PER_DELIVERY);
  }

  tierFor(points: number) {
    let current = TIERS[0];
    let next: (typeof TIERS)[number] | null = null;
    for (const t of TIERS) {
      if (points >= t.min) current = t;
      else { next = t; break; }
    }
    return {
      tier: current.name,
      nextTier: next?.name ?? null,
      pointsToNextTier: next ? next.min - points : 0,
    };
  }

  /** A brand-new signup came in with someone else's referral code: link the
   * accounts and credit the referrer. Only ever called right after a new
   * user row is created (see AuthService.requestOtp) — never on repeat
   * logins, so a referral can't be claimed twice. */
  async applyReferral(newUserId: string, referralCode: string): Promise<{ referrerId: string } | null> {
    const referrer = await this.prisma.user.findUnique({ where: { referralCode: referralCode.toUpperCase() } });
    if (!referrer || referrer.id === newUserId) return null;
    await this.prisma.user.update({ where: { id: newUserId }, data: { referredById: referrer.id } });
    await this.awardPoints(referrer.id, REFERRAL_BONUS_POINTS);
    return { referrerId: referrer.id };
  }

  async getLoyalty(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const referralCode = user.referralCode ?? (await this.ensureReferralCode(userId));
    const referralCount = await this.prisma.user.count({ where: { referredById: userId } });
    const { tier, nextTier, pointsToNextTier } = this.tierFor(user.loyaltyPoints);
    return {
      points: user.loyaltyPoints,
      tier,
      nextTier,
      pointsToNextTier,
      referralCode,
      referralCount,
      referralBonusPoints: REFERRAL_BONUS_POINTS,
      pointsPerTrip: POINTS_PER_TRIP,
      pointsPerDelivery: POINTS_PER_DELIVERY,
    };
  }
}
