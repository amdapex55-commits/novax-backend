import { Module } from "@nestjs/common";
import { TripsService } from "./trips.service";
import { TripsController } from "./trips.controller";
import { PublicTripsController } from "./public-trips.controller";
import { LocationModule } from "../location/location.module";
import { LedgerModule } from "../ledger/ledger.module";
import { RatingsModule } from "../ratings/ratings.module";
import { LoyaltyModule } from "../loyalty/loyalty.module";

@Module({
  imports: [LocationModule, LedgerModule, RatingsModule, LoyaltyModule],
  controllers: [TripsController, PublicTripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
