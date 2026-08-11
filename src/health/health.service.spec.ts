import { HealthService } from "./health.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { RedisService } from "../redis/redis.service";

// The readiness probe is the thing Railway gates a deploy on, so its failure
// behaviour matters more than its happy path: it has to report "down" for an
// unreachable dependency and it must not hang when one never answers.

const makePrisma = (impl: () => Promise<unknown>) =>
  ({ $queryRaw: impl } as unknown as PrismaService);

const makeRedis = (impl: () => Promise<unknown>) =>
  ({ client: { ping: impl } } as unknown as RedisService);

const ok = () => Promise.resolve([{ "?column?": 1 }]);
const pong = () => Promise.resolve("PONG");

describe("HealthService.readiness", () => {
  beforeEach(() => {
    // Silence the expected "probe failed" warnings in failure-path tests.
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("reports ok when both dependencies answer", async () => {
    const service = new HealthService(makePrisma(ok), makeRedis(pong));

    const report = await service.readiness();

    expect(report.status).toBe("ok");
    expect(report.checks.database.status).toBe("up");
    expect(report.checks.redis.status).toBe("up");
    expect(typeof report.uptimeSeconds).toBe("number");
  });

  it("reports degraded, not a thrown error, when the database is unreachable", async () => {
    const service = new HealthService(
      makePrisma(() => Promise.reject(new Error("ECONNREFUSED"))),
      makeRedis(pong),
    );

    const report = await service.readiness();

    // A readiness check that throws becomes a 500 and tells the load balancer
    // nothing useful — it has to degrade gracefully into a report.
    expect(report.status).toBe("degraded");
    expect(report.checks.database.status).toBe("down");
    expect(report.checks.database.error).toContain("ECONNREFUSED");
    expect(report.checks.redis.status).toBe("up");
  });

  it("reports degraded when Redis is unreachable", async () => {
    const service = new HealthService(
      makePrisma(ok),
      makeRedis(() => Promise.reject(new Error("redis is down"))),
    );

    const report = await service.readiness();

    expect(report.status).toBe("degraded");
    expect(report.checks.redis.status).toBe("down");
    expect(report.checks.database.status).toBe("up");
  });

  it("times out a hanging dependency instead of hanging with it", async () => {
    jest.useFakeTimers();

    const service = new HealthService(
      makePrisma(() => new Promise(() => undefined)), // never settles
      makeRedis(pong),
    );

    const pending = service.readiness();
    await jest.advanceTimersByTimeAsync(2_500);
    const report = await pending;

    expect(report.status).toBe("degraded");
    expect(report.checks.database.status).toBe("down");
    expect(report.checks.database.error).toContain("timed out");

    jest.useRealTimers();
  });

  it("probes dependencies in parallel, so two slow deps cost one timeout", async () => {
    jest.useFakeTimers();

    const service = new HealthService(
      makePrisma(() => new Promise(() => undefined)),
      makeRedis(() => new Promise(() => undefined)),
    );

    const pending = service.readiness();
    // Advancing by a single timeout window must settle BOTH probes. If they
    // ran sequentially this would still be unresolved.
    await jest.advanceTimersByTimeAsync(2_100);
    const report = await pending;

    expect(report.checks.database.status).toBe("down");
    expect(report.checks.redis.status).toBe("down");

    jest.useRealTimers();
  });
});
