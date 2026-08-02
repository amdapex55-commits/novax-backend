import { Module } from "@nestjs/common";
import { TripsService } from "./trips.service";
import { TripsController } from "./trips.controller";
import { LocationModule } from "../location/location.module";
import { LedgerModule } from "../ledger/ledger.module";
import { RatingsModule } from "../ratings/ratings.module";
import { LoyaltyModule } from "../loyalty/loyalty.module";

@Module({
  imports: [LocationModule, LedgerModule, RatingsModule, LoyaltyModule],
  controllers: [TripsController],
  providers: [TripsService],
})
export class TripsModule {}
