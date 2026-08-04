import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { CurrentUser } from "./current-user.decorator";
import { LedgerService } from "./ledger.service";
import { TopUpDto } from "./top-up.dto";

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

  @Post("topup")
  async topUp(@CurrentUser() user: { userId: string }, @Body() dto: TopUpDto) {
    await this.ledgerService.topUp(user.userId, dto.amount);
    return this.ledgerService.getBalance(user.userId);
  }
}
