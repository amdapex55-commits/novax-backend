import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { BusinessService } from "./business.service";
import { CreateLeadDto } from "./dto/create-lead.dto";

@ApiTags("business")
@Controller("api/v1/business")
export class BusinessController {
  constructor(private businessService: BusinessService) {}

  // Deliberately no auth guard — guests browsing the "Nova Go for Business"
  // page can submit interest without creating an account first.
  @Post("leads")
  create(@Body() dto: CreateLeadDto) {
    return this.businessService.createLead(dto);
  }

  @Get("leads")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("ADMIN")
  list() {
    return this.businessService.listLeads();
  }
}
