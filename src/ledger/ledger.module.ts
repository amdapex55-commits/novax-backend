import { Module } from "@nestjs/common";
import { LedgerService } from "./ledger.service";
import { WalletController } from "./wallet.controller";

@Module({
  controllers: [WalletController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
