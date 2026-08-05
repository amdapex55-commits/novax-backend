// 15%, undercutting Bykea's 20% driver commission — see the positioning notes
// from earlier in this build: winning driver supply from the post-Careem-exit
// pool is the whole point of pricing below the incumbent. Move this to an
// admin-configurable value (per the engineering roadmap's pricing-config
// page) before you need to change it without a redeploy.
export const COMMISSION_RATE = 0.15;

// grossAmount is typed loosely (not just `number`) because every real call
// site is handing this a value just read back off a Prisma Decimal column
// (trip.fare, delivery.fare, order.deliveryFee, ...) — Prisma's generated
// type for those is Decimal, not number. Number(x) on a Decimal instance
// calls its .toString()/.valueOf() and parses correctly; Number(x) on an
// already-plain number is a no-op. Centralizing the conversion here means
// callers never have to remember to do it themselves before this function
// tries to multiply.
export function splitFare(grossAmountInput: number | { toString(): string }, commissionRate: number = COMMISSION_RATE) {
  const grossAmount = Number(grossAmountInput);
  const commissionAmount = Math.round(grossAmount * commissionRate * 100) / 100;
  const netAmount = Math.round((grossAmount - commissionAmount) * 100) / 100;
  return { grossAmount, commissionRate, commissionAmount, netAmount };
}
