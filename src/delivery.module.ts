import { Module } from "@nestjs/common";
import { DeliveryService } from "./delivery.service";
import { DeliveryController } from "./delivery.controller";
import { LocationModule } from "./location.module";
import { LedgerModule } from "./ledger.module";
import { RatingsModule } from "./ratings.module";
import { LoyaltyModule } from "./loyalty.module";

@Module({
  imports: [LocationModule, LedgerModule, RatingsModule, LoyaltyModule],
  controllers: [DeliveryController],
  providers: [DeliveryService],
})
export class DeliveryModule {}
