import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

export type DependencyStatus = {
  status: "up" | "down";
  latencyMs: number;
  error?: string;
};

export type ReadinessReport = {
  status: "ok" | "degraded";
  uptimeSeconds: number;
  checks: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
};

// A health check that can hang forever is worse than no health check: the
// platform waits on it instead of failing over. Every dependency probe is
// capped, and a timeout counts as "down".
const PROBE_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    // Probe both in parallel — a readiness check is on the deploy critical
    // path, so it should cost one timeout at worst, not two.
    const [database, redis] = await Promise.all([
      this.probe("database", () => this.prisma.$queryRaw`SELECT 1`),
      this.probe("redis", () => this.redis.client.ping()),
    ]);

    return {
      status: database.status === "up" && redis.status === "up" ? "ok" : "degraded",
      uptimeSeconds: Math.round(process.uptime()),
      checks: { database, redis },
    };
  }

  private async probe(name: string, run: () => Promise<unknown>): Promise<DependencyStatus> {
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        run(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms`)),
            PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      return { status: "up", latencyMs: Date.now() - startedAt };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Health probe "${name}" failed: ${error}`);
      return { status: "down", latencyMs: Date.now() - startedAt, error };
    } finally {
      // Otherwise the losing timer keeps the event loop alive for its full
      // duration on every single health check.
      if (timer) clearTimeout(timer);
    }
  }
}
