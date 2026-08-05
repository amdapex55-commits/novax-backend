import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { SafetyService } from "./safety.service";
import { CreateIncidentDto, ResolveIncidentDto } from "./dto/create-incident.dto";

type ReqUser = { userId: string; role: string };

@ApiTags("safety")
@ApiBearerAuth()
@Controller("api/v1/safety")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SafetyController {
  constructor(private safetyService: SafetyService) {}

  // Any authenticated role can raise one — a driver in trouble needs this
  // as much as a rider does. No @Roles on purpose.
  @Post("incidents")
  @ApiOperation({ summary: "Raise an SOS / safety incident" })
  raise(@CurrentUser() user: ReqUser, @Body() dto: CreateIncidentDto) {
    return this.safetyService.raiseIncident(user.userId, dto);
  }

  @Get("incidents/open")
  @Roles("ADMIN")
  listOpen() {
    return this.safetyService.listOpen();
  }

  @Get("incidents")
  @Roles("ADMIN")
  listAll() {
    return this.safetyService.listAll();
  }

  @Patch("incidents/:id")
  @Roles("ADMIN")
  update(@CurrentUser() user: ReqUser, @Param("id") id: string, @Body() dto: ResolveIncidentDto) {
    return this.safetyService.updateStatus(id, user.userId, dto.status, dto.resolution);
  }
}
