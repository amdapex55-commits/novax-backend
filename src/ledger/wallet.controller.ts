import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { LedgerService } from "./ledger.service";

@ApiTags("wallet")
@ApiBearerAuth()
@Controller("api/v1/wallet")
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private ledgerService: LedgerService) {}

  @Get("balance")
  getBalance(@CurrentUser() user: { userId: string }) {
    return this.ledgerService.getBalance(user.userId);
  }

  @Get("history")
  getHistory(@CurrentUser() user: { userId: string }) {
    return this.ledgerService.getHistory(user.userId);
  }
}
