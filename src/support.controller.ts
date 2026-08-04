import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { RolesGuard } from "./roles.guard";
import { Roles } from "./roles.decorator";
import { CurrentUser } from "./current-user.decorator";
import { SupportService } from "./support.service";
import { CreateTicketDto } from "./create-ticket.dto";

@ApiTags("support")
@ApiBearerAuth()
@Controller("api/v1/support/tickets")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SupportController {
  constructor(private supportService: SupportService) {}

  @Post()
  create(@CurrentUser() user: { userId: string }, @Body() dto: CreateTicketDto) {
    return this.supportService.createTicket(user.userId, dto.subject, dto.message);
  }

  @Get("me")
  listMine(@CurrentUser() user: { userId: string }) {
    return this.supportService.listMine(user.userId);
  }

  @Get()
  @Roles("ADMIN")
  listAll() {
    return this.supportService.listAll();
  }
}
