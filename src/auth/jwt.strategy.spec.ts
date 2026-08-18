import { JwtStrategy } from "./jwt.strategy";

/* ---------------------------------------------------------------------------
   A signature only proves we issued the token. It says nothing about whether
   the account still exists, is still allowed in, or still has the role it had
   when the token was minted — and access tokens live for 30 days.

   Revocation is written to Redis and is allowed to fail soft, so the database
   is the authority these tests pin down.
   --------------------------------------------------------------------------- */

const config = { get: () => "test-secret" } as any;

const make = (opts: { revoked?: boolean; user?: any } = {}) => {
  const findUnique = jest.fn().mockResolvedValue(opts.user === undefined ? { isActive: true, role: "RIDER" } : opts.user);
  const denylist = { isRevoked: jest.fn().mockResolvedValue(opts.revoked ?? false) } as any;
  const prisma = { user: { findUnique } } as any;
  return { strategy: new JwtStrategy(config, denylist, prisma), findUnique, denylist };
};

describe("JwtStrategy.validate — the database decides, not the token", () => {
  it("rejects a token whose account has been deleted, even if revocation never reached Redis", async () => {
    // This is the exact hole: revoke() failed, so the denylist is clean, but
    // the row is gone. Before this check the token kept working for 30 days.
    const { strategy } = make({ revoked: false, user: null });
    await expect(strategy.validate({ sub: "gone", role: "RIDER" } as any)).rejects.toThrow(/no longer exists/i);
  });

  it("rejects a suspended account even when the denylist is clean", async () => {
    const { strategy } = make({ revoked: false, user: { isActive: false, role: "DRIVER" } });
    await expect(strategy.validate({ sub: "susp", role: "DRIVER" } as any)).rejects.toThrow(/suspended/i);
  });

  it("still rejects anything the denylist knows about, without touching the database", async () => {
    const { strategy, findUnique } = make({ revoked: true });
    await expect(strategy.validate({ sub: "revoked", role: "RIDER" } as any)).rejects.toThrow(/no longer valid/i);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("uses the DATABASE role, not the role baked into the token", async () => {
    // An ops demotion has to take effect on the next request. Trusting
    // payload.role would leave a stale ADMIN token fully privileged until it
    // expired — the token is the last place to read an authorisation
    // decision from.
    const { strategy } = make({ user: { isActive: true, role: "RIDER" } });
    const result = await strategy.validate({ sub: "u1", role: "ADMIN" } as any);
    expect(result).toEqual({ userId: "u1", role: "RIDER" });
  });

  it("admits a live, active account", async () => {
    const { strategy } = make({ user: { isActive: true, role: "DRIVER" } });
    await expect(strategy.validate({ sub: "u2", role: "DRIVER" } as any)).resolves.toEqual({
      userId: "u2",
      role: "DRIVER",
    });
  });
});
