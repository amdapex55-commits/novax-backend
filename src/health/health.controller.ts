import { Controller, Get, HttpCode, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Response } from "express";
import { HealthService } from "./health.service";

// Deliberately unauthenticated and unthrottled: the platform's health checker
// has no credentials, and it polls often enough to trip the global 20/60s
// rate limit and take the service down by declaring it unhealthy.
@ApiTags("health")
@Controller("health")
@SkipThrottle()
export class HealthController {
  constructor(private health: HealthService) {}

  // Liveness: is the process up and serving? No dependency checks, so a
  // Postgres blip never gets the container killed and restarted — a restart
  // wouldn't fix a database outage anyway.
  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: "Liveness probe — always 200 while the process serves traffic" })
  live() {
    return { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
  }

  // Readiness: can this instance actually do work? Point Railway's health
  // check here — at deploy time you specifically want traffic held back
  // until the new container can reach Postgres and Redis.
  @Get("ready")
  @ApiOperation({ summary: "Readiness probe — 200 when Postgres and Redis are both reachable" })
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.health.readiness();
    // 503 rather than 200-with-a-sad-body: load balancers route on status
    // codes, not on JSON fields.
    res.status(report.status === "ok" ? 200 : 503);
    return report;
  }
}
