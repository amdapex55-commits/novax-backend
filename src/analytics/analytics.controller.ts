import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { AnalyticsService } from "./analytics.service";
import { TrackEventDto } from "./dto/track-event.dto";

@ApiTags("analytics")
@Controller("api/v1/analytics")
export class AnalyticsController {
  constructor(private analyticsService: AnalyticsService) {}

  /**
   * Deliberately NOT behind JwtAuthGuard: the most important events in the
   * funnel (app_opened, otp_requested) happen before anyone has a token, and
   * gating them would make the top of the funnel permanently invisible.
   *
   * If a token happens to be present we attribute the event to that user;
   * otherwise it's anonymous. Rate-limited because it's a public write.
   */
  @Post("track")
  @ApiOperation({ summary: "Record a funnel event (auth optional)" })
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async track(@Body() dto: TrackEventDto, @Req() req: any) {
    const user = req.user as { userId?: string; role?: string } | undefined;
    await this.analyticsService.track(dto.name, user?.userId, user?.role, dto.props);
    return { ok: true };
  }

  @Get("funnel")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  @ApiOperation({ summary: "Funnel counts + conversion rates for the ops dashboard" })
  getFunnel(@Query("days") days?: string) {
    const parsed = Number(days);
    return this.analyticsService.getFunnel(Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 90) : 7);
  }
}
