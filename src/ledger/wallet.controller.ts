import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { LedgerService } from "./ledger.service";
import { TopUpDto } from "./dto/top-up.dto";
import { WithdrawDto } from "./dto/withdraw.dto";

@ApiTags("wallet")
@ApiBearerAuth()
@Controller("api/v1/wallet")
@UseGuards(JwtAuthGuard, RolesGuard)
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

  @Get("earnings")
  @Roles("DRIVER")
  getEarnings(@CurrentUser() user: { userId: string }) {
    return this.ledgerService.getDriverEarnings(user.userId);
  }

  // ADMIN-only, and takes an explicit target userId — there's no real
  // payment gateway wired in yet (EasyPaisa/JazzCash integration is still
  // on the roadmap), so this used to let ANY logged-in rider credit their
  // own wallet for free by just calling this endpoint. Until a real payment
  // webhook exists, this is a manual ops tool (support crediting a refund,
  // a promo bonus, etc.), not a self-service top-up — the app's own "Add
  // Money" button in the wallet screen should be treated as not-yet-wired
  // to real money until this is replaced with payment-provider verification.
  // Cash out a COD balance. The sender's own money, so no admin role — but
  // the amount is checked against their real balance server-side, because a
  // client-supplied amount is a request, not a fact.
  @Post("withdraw")
  @ApiOperation({ summary: "Withdraw a positive wallet balance to JazzCash, Easypaisa or a bank" })
  withdraw(@CurrentUser() user: { userId: string }, @Body() dto: WithdrawDto) {
    return this.ledgerService.requestWithdrawal(user.userId, dto.amount, `${dto.method}:${dto.destination}`);
  }

  @Post("admin/topup/:userId")
  @Roles("ADMIN")
  async adminTopUp(@Param("userId") userId: string, @Body() dto: TopUpDto) {
    await this.ledgerService.topUp(userId, dto.amount);
    return this.ledgerService.getBalance(userId);
  }
}
