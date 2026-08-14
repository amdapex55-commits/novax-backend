import { assessCancellation, CANCELLATION_POLICY } from "./cancellation.util";

// Cancellation is where a marketplace quietly makes enemies: charge too
// eagerly and customers leave, never charge and riders absorb every wasted
// journey. Each test is one of those judgement calls, pinned.

const base = {
  cancelledBy: "RIDER" as const,
  status: "MATCHED",
  matchedAt: new Date("2026-08-14T10:00:00Z"),
  isTest: false,
  now: new Date("2026-08-14T10:05:00Z"),
};

describe("assessCancellation", () => {
  it("never charges for cancelling before anyone accepted", () => {
    // Nobody has done anything yet. Charging here would be charging for
    // changing your mind about a request that cost no one a journey.
    const r = assessCancellation({ ...base, status: "REQUESTED", matchedAt: null });
    expect(r.fee).toBe(0);
    expect(r.countsAgainstDriver).toBe(false);
  });

  it("never charges within the grace window after matching", () => {
    // A fee a mis-tap can trigger is a support ticket, not revenue.
    const r = assessCancellation({
      ...base,
      now: new Date(base.matchedAt.getTime() + CANCELLATION_POLICY.graceMs - 1),
    });
    expect(r.fee).toBe(0);
  });

  it("never charges the customer when the DRIVER cancels", () => {
    const r = assessCancellation({ ...base, cancelledBy: "DRIVER" });
    expect(r.fee).toBe(0);
    expect(r.reason).toMatch(/not been charged/i);
  });

  it("counts a driver cancellation against them only if they had accepted", () => {
    // Declining an offer they never accepted is already counted as a decline.
    // Counting it twice would make declining look worse than accepting and
    // then abandoning, which is exactly backwards.
    expect(assessCancellation({ ...base, cancelledBy: "DRIVER", status: "MATCHED" }).countsAgainstDriver).toBe(true);
    expect(assessCancellation({ ...base, cancelledBy: "DRIVER", status: "MATCHING" }).countsAgainstDriver).toBe(false);
  });

  it("never charges on a test trip", () => {
    // A store reviewer must never be told they owe a cancellation fee.
    const r = assessCancellation({ ...base, isTest: true });
    expect(r.fee).toBe(0);
  });

  it("charges the configured fee once the rider is genuinely on the way", () => {
    // The pilot ships with riderLateFee = 0 deliberately; this proves the
    // mechanism works so switching it on is one number, not a retrofit of the
    // disclosure, receipt line and dispute path at the same time.
    const r = assessCancellation(base, { riderLateFee: 30, graceMs: CANCELLATION_POLICY.graceMs });
    expect(r.fee).toBe(30);
    expect(r.reason).toMatch(/Rs 30/);
  });

  it("ships with no fee during the pilot, and says so", () => {
    const r = assessCancellation(base);
    expect(r.fee).toBe(0);
    expect(r.reason).toMatch(/no fee during the pilot/i);
  });
});
