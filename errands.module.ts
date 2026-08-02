import { Module } from "@nestjs/common";
import { ErrandsService } from "./errands.service";
import { ErrandsController } from "./errands.controller";
import { LocationModule } from "../location/location.module";
import { LedgerModule } from "../ledger/ledger.module";
import { LoyaltyModule } from "../loyalty/loyalty.module";

@Module({
  imports: [LocationModule, LedgerModule, LoyaltyModule],
  controllers: [ErrandsController],
  providers: [ErrandsService],
})
export class ErrandsModule {}
