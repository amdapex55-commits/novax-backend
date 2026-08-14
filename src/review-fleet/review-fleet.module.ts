import { Module } from "@nestjs/common";
import { ReviewFleetService } from "./review-fleet.service";
import { LocationModule } from "../location/location.module";
import { TripsModule } from "../trips/trips.module";

@Module({
  imports: [LocationModule, TripsModule],
  providers: [ReviewFleetService],
})
export class ReviewFleetModule {}
