// 15%, undercutting Bykea's 20% driver commission — see the positioning notes
// from earlier in this build: winning driver supply from the post-Careem-exit
// pool is the whole point of pricing below the incumbent. Move this to an
// admin-configurable value (per the engineering roadmap's pricing-config
// page) before you need to change it without a redeploy.
export const COMMISSION_RATE = 0.15;

export function splitFare(grossAmount: number, commissionRate: number = COMMISSION_RATE) {
  const commissionAmount = Math.round(grossAmount * commissionRate * 100) / 100;
  const netAmount = Math.round((grossAmount - commissionAmount) * 100) / 100;
  return { grossAmount, commissionRate, commissionAmount, netAmount };
}
