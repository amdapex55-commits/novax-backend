import { TokenDenylistService, parseTtlSeconds } from "./token-denylist.service";

const makeService = (client: any, ttl = "30d") =>
  new TokenDenylistService({ client } as any, { get: () => ttl } as any);

describe("parseTtlSeconds", () => {
  it("reads the units jsonwebtoken accepts", () => {
    expect(parseTtlSeconds("30d")).toBe(2592000);
    expect(parseTtlSeconds("15m")).toBe(900);
    expect(parseTtlSeconds("2h")).toBe(7200);
    expect(parseTtlSeconds("3600")).toBe(3600);
  });

  it("falls back to the LONGEST window on junk, never the shortest", () => {
    // A 0 here would expire the denylist entry immediately and quietly
    // reopen the hole this service exists to close.
    expect(parseTtlSeconds("bananas")).toBe(2592000);
    expect(parseTtlSeconds("")).toBe(2592000);
  });
});

describe("TokenDenylistService", () => {
  it("holds a revoked user for the full access-token lifetime", async () => {
    const set = jest.fn().mockResolvedValue("OK");
    await makeService({ set }).revoke("user-1", "account deleted");
    expect(set).toHaveBeenCalledWith("auth:revoked:user-1", "account deleted", "EX", 2592000);
  });

  it("rejects a revoked user and admits everyone else", async () => {
    const exists = jest.fn().mockResolvedValue(1);
    await expect(makeService({ exists }).isRevoked("user-1")).resolves.toBe(true);
    await expect(makeService({ exists: jest.fn().mockResolvedValue(0) }).isRevoked("user-2")).resolves.toBe(false);
  });

  it("clears on reactivation so an unsuspended user keeps their session", async () => {
    const del = jest.fn().mockResolvedValue(1);
    await makeService({ del }).restore("user-1");
    expect(del).toHaveBeenCalledWith("auth:revoked:user-1");
  });

  it("FAILS OPEN when Redis is down, rather than signing out the platform", async () => {
    const exists = jest.fn().mockRejectedValue(new Error("redis is down"));
    await expect(makeService({ exists }).isRevoked("user-1")).resolves.toBe(false);
  });

  it("does not throw out of revoke when Redis is down", async () => {
    // The account is still anonymised/suspended; a Redis outage must not roll
    // that back or surface as a 500 to the person deleting their account.
    const set = jest.fn().mockRejectedValue(new Error("redis is down"));
    await expect(makeService({ set }).revoke("user-1", "account deleted")).resolves.toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
   Fail-closed path for money and access.

   The ordinary read deliberately fails OPEN: failing closed on a Redis blink
   would sign out every driver on the platform, including mid-trip, which is a
   far larger incident than one revoked session on a device the person already
   holds. These tests exist to make sure that trade-off stays confined to
   ordinary traffic and never leaks into the operations revocation exists to
   stop.
   --------------------------------------------------------------------------- */
describe("TokenDenylistService — sensitive actions fail closed", () => {
  const down = () => {
    throw new Error("ECONNREFUSED");
  };

  it("REFUSES a sensitive action when Redis is unreachable", async () => {
    const svc = makeService({ exists: jest.fn(down) });
    await expect(svc.assertNotRevokedForSensitiveAction("driver-1", "wallet-withdraw")).rejects.toThrow(
      /can't verify your session/i,
    );
  });

  it("still allows ORDINARY traffic when Redis is unreachable — a trip must not be interrupted", async () => {
    const svc = makeService({ exists: jest.fn(down) });
    // The same outage, the same user: normal requests keep working.
    await expect(svc.isRevoked("driver-1")).resolves.toBe(false);
  });

  it("refuses a sensitive action for a genuinely revoked session", async () => {
    const svc = makeService({ exists: jest.fn().mockResolvedValue(1) });
    await expect(svc.assertNotRevokedForSensitiveAction("driver-1", "wallet-withdraw")).rejects.toThrow(
      /no longer valid/i,
    );
  });

  it("permits a sensitive action for a live session", async () => {
    const svc = makeService({ exists: jest.fn().mockResolvedValue(0) });
    await expect(svc.assertNotRevokedForSensitiveAction("driver-1", "wallet-withdraw")).resolves.toBeUndefined();
  });

  it("reports degradation so an outage is observable, and clears it on recovery", async () => {
    const exists = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const svc = makeService({ exists });
    expect(svc.isDegraded()).toBe(false);
    await svc.isRevoked("driver-1");
    expect(svc.isDegraded()).toBe(true);
    exists.mockResolvedValue(0);
    await svc.isRevoked("driver-1");
    expect(svc.isDegraded()).toBe(false);
  });
});
