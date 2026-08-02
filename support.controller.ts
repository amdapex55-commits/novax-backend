import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { SupportService } from "./support.service";
import { CreateTicketDto } from "./dto/create-ticket.dto";

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
