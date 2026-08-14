import { PushService } from "./push.service";

// Push is the system most likely to fail silently: a wrong app scope or a
// swallowed error looks identical to "nothing happened". These pin the
// behaviours that would otherwise only be discovered by a user not being told
// something.

function makeService(config: Record<string, string>, prisma: any) {
  return new PushService(
    { get: (k: string, d?: string) => config[k] ?? d } as any,
    prisma as any,
  );
}

describe("PushService", () => {
  describe("targeting", () => {
    it("only sends to devices registered for the SAME app", async () => {
      // A phone with both Nova Go apps installed has two tokens for one
      // person. Delivering "you have a new job" to the customer build is the
      // bug this exists to prevent.
      const findMany = jest.fn().mockResolvedValue([]);
      const svc = makeService({ PUSH_PROVIDER: "console" }, { deviceToken: { findMany } });
      await svc.sendToUser("user-1", "driver", { title: "t", body: "b" });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1", app: "driver" } }),
      );
    });

    it("does nothing when the user has no devices", async () => {
      const svc = makeService(
        { PUSH_PROVIDER: "console" },
        { deviceToken: { findMany: jest.fn().mockResolvedValue([]) } },
      );
      await expect(svc.sendToUser("u", "customer", { title: "t", body: "b" })).resolves.toBeUndefined();
    });
  });

  describe("failure containment", () => {
    it("never throws when the database is down", async () => {
      // A push failing must not fail the thing it was reporting on. A trip
      // does not stop completing because a notification could not be sent.
      const svc = makeService(
        { PUSH_PROVIDER: "console" },
        { deviceToken: { findMany: jest.fn().mockRejectedValue(new Error("db is down")) } },
      );
      await expect(svc.sendToUser("u", "customer", { title: "t", body: "b" })).resolves.toBeUndefined();
    });

    it("never throws on an unknown provider", async () => {
      const svc = makeService({ PUSH_PROVIDER: "carrier-pigeon" }, {});
      await expect(svc.sendToToken("tok", { title: "t", body: "b" })).resolves.toBeUndefined();
    });
  });

  describe("isConfigured", () => {
    it("is false in console mode, so callers know push cannot reach a phone", () => {
      expect(makeService({ PUSH_PROVIDER: "console" }, {}).isConfigured).toBe(false);
    });

    it("is false when fcm is selected but the service account is missing", () => {
      // The failure mode this catches: PUSH_PROVIDER flipped to fcm on deploy
      // without the credential, so every send silently no-ops.
      expect(makeService({ PUSH_PROVIDER: "fcm" }, {}).isConfigured).toBe(false);
    });

    it("is true only when fcm has its credentials", () => {
      const svc = makeService(
        { PUSH_PROVIDER: "fcm", FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"x"}' },
        {},
      );
      expect(svc.isConfigured).toBe(true);
    });
  });

  describe("device registry", () => {
    it("upserts on the TOKEN so a shared phone re-homes to its new owner", async () => {
      // Keying on userId instead would leave the old row alive, and the
      // previous driver would keep receiving this handset's job offers.
      const upsert = jest.fn().mockResolvedValue({});
      const svc = makeService({}, { deviceToken: { upsert } });
      await svc.registerDevice("new-owner", "tok-123", "android", "driver");
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { token: "tok-123" },
          update: expect.objectContaining({ userId: "new-owner" }),
        }),
      );
    });

    it("deletes by token on sign-out", async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
      const svc = makeService({}, { deviceToken: { deleteMany } });
      await svc.unregisterDevice("tok-123");
      expect(deleteMany).toHaveBeenCalledWith({ where: { token: "tok-123" } });
    });
  });
});
