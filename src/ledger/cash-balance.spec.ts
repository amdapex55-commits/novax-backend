import { splitFare } from "./commission.util";

/* ---------------------------------------------------------------------------
   What a driver owes after a cash trip.

   The passenger pays at the kerb, so the driver leaves holding the full gross.
   A completed trip used to write only a positive TRIP_PAYOUT — crediting them
   a second time, on our books, for money we never sent. Nothing recorded the
   commission owed, so:

     - a wallet balance could only ever rise
     - the credit limit meant to stop dispatching to someone Rs 2,000 behind
       could never fire, because nobody could ever be behind
     - the ops settlement screen had nothing to settle

   Two entries fix it, and these tests pin the arithmetic that connects them.
   --------------------------------------------------------------------------- */

const balanceAfterCashTrip = (fare: number) => {
  const split = splitFare(fare);
  const payout = Number(split.netAmount);          // TRIP_PAYOUT
  const cashHeld = -Number(split.grossAmount);     // TRIP_CASH_COLLECTED
  return { payout, cashHeld, balance: payout + cashHeld, commission: Number(split.commissionAmount) };
};

describe("a completed cash trip leaves the driver owing exactly the commission", () => {
  it("the first real trip: Rs 215 at 15%", () => {
    const r = balanceAfterCashTrip(215);
    expect(r.payout).toBeCloseTo(182.75, 2);
    expect(r.commission).toBeCloseTo(32.25, 2);
    // The whole point: negative, and negative by the commission.
    expect(r.balance).toBeCloseTo(-32.25, 2);
    expect(r.balance).toBeCloseTo(-r.commission, 2);
  });

  it("holds for any fare — balance is always minus the commission", () => {
    for (const fare of [80, 150, 215, 337.5, 1200]) {
      const r = balanceAfterCashTrip(fare);
      expect(r.balance).toBeCloseTo(-r.commission, 2);
      expect(r.balance).toBeLessThan(0);
    }
  });

  it("debt accumulates across trips, which is what the credit limit reads", () => {
    const total = [215, 215, 400].reduce((sum, f) => sum + balanceAfterCashTrip(f).balance, 0);
    expect(total).toBeLessThan(0);
    // Three trips should not somehow leave a driver in credit.
    expect(total).toBeCloseTo(-(32.25 + 32.25 + 60), 2);
  });

  it("earnings and balance answer different questions and must not be conflated", () => {
    const r = balanceAfterCashTrip(215);
    // Earnings sums PAYOUT_TYPES only, so it stays positive and unchanged.
    expect(r.payout).toBeGreaterThan(0);
    // Balance sums everything, so it shows the debt.
    expect(r.balance).toBeLessThan(0);
    expect(r.payout).not.toBeCloseTo(r.balance, 2);
  });
});
