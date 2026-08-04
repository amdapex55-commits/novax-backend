import { Module } from "@nestjs/common";
import { TripsService } from "./trips.service";
import { TripsController } from "./trips.controller";
import { PublicTripsController } from "./public-trips.controller";
import { LocationModule } from "./location.module";
import { LedgerModule } from "./ledger.module";
import { RatingsModule } from "./ratings.module";
import { LoyaltyModule } from "./loyalty.module";

@Module({
  imports: [LocationModule, LedgerModule, RatingsModule, LoyaltyModule],
  controllers: [TripsController, PublicTripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
