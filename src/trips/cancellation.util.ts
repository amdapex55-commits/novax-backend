/**
 * Nova Go — what a cancellation costs, and who it counts against.
 *
 * WHY A FEE AT ALL, AND WHY IT IS ZERO TODAY
 *
 * A customer who cancels after a rider has accepted has already cost that
 * rider something real: they stopped looking for other work and started
 * riding toward a pickup, burning their own petrol. In a cash market where
 * the rider keeps 85%, that loss is entirely theirs.
 *
 * The pilot's fee is nevertheless Rs 0 — see CANCELLATION_POLICY below. A new
 * service charging people for a rider who has not arrived yet will lose more
 * customers than it recovers rupees, and the rider's real protection is that
 * repeat offenders get flagged rather than that one customer pays Rs 30.
 *
 * The MECHANISM exists now, switched off, because retrofitting a fee later
 * means retrofitting the disclosure, the receipt line and the dispute path at
 * the same time. This way turning it on is one number.
 *
 * WHAT IS NEVER CHARGED
 *
 *   - cancelling before anyone accepted. Nobody has done anything yet.
 *   - the driver cancelling. Their cost, not the customer's.
 *   - a test trip.
 */

export type CancelActor = "RIDER" | "DRIVER";

export const CANCELLATION_POLICY = {
  /** Rs charged to a customer who cancels after a rider accepted. 0 = off. */
  riderLateFee: 0,
  /**
   * Grace window after acceptance. Even with a fee configured, a customer who
   * changes their mind within thirty seconds has not really cost anyone a
   * journey — and a fee that can be triggered by a mis-tap is a support
   * ticket, not revenue.
   */
  graceMs: 30_000,
  /** Cancellations in a rolling week before ops should look at an account. */
  riderFlagThreshold: 3,
  driverFlagThreshold: 3,
} as const;

export interface CancellationContext {
  cancelledBy: CancelActor;
  /** Status the trip was in when cancel was called. */
  status: string;
  /** When the driver accepted, if they did. */
  matchedAt: Date | null;
  isTest: boolean;
  now?: Date;
}

export interface CancellationOutcome {
  fee: number;
  /** Plain sentence for the receipt and the confirmation dialog. */
  reason: string;
  /** True when this one should count toward a driver's reliability score. */
  countsAgainstDriver: boolean;
}

/**
 * @param policy injectable so tests can prove the fee mechanism works while
 *        the pilot ships with it set to zero. A pure function taking its
 *        configuration is also the only way to check the "fee is on" branch
 *        without a global mock — and a branch nobody can test is a branch
 *        that breaks the day you switch it on.
 */
export function assessCancellation(
  ctx: CancellationContext,
  policy: { riderLateFee: number; graceMs: number } = CANCELLATION_POLICY,
): CancellationOutcome {
  const now = ctx.now ?? new Date();

  if (ctx.isTest) {
    return { fee: 0, reason: "Test trip — no fee.", countsAgainstDriver: false };
  }

  if (ctx.cancelledBy === "DRIVER") {
    // Counted against the driver ONLY when they had actually taken the job.
    // Declining an offer they never accepted is a decline, and is already
    // counted as one — charging it twice would make declining look worse than
    // accepting-then-abandoning, which is exactly backwards.
    return {
      fee: 0,
      reason: "Your rider cancelled — you have not been charged.",
      countsAgainstDriver: ctx.status === "MATCHED",
    };
  }

  const acceptedYet = ctx.status === "MATCHED" && !!ctx.matchedAt;
  if (!acceptedYet) {
    return { fee: 0, reason: "Cancelled before a rider accepted — no charge.", countsAgainstDriver: false };
  }

  const sinceAccept = now.getTime() - new Date(ctx.matchedAt!).getTime();
  if (sinceAccept < policy.graceMs) {
    return { fee: 0, reason: "Cancelled straight after matching — no charge.", countsAgainstDriver: false };
  }

  const fee = policy.riderLateFee;
  return {
    fee,
    reason: fee > 0
      ? `Your rider was already on the way, so a Rs ${fee} cancellation fee applies.`
      : "Your rider was already on the way. No fee during the pilot.",
    countsAgainstDriver: false,
  };
}
