import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { LocationService } from "./location.service";
import { LocationGateway } from "./location.gateway";
import { ExcludedDriversStore } from "./excluded-drivers.store";
import { LocationController } from "./location.controller";

@Module({
  imports: [JwtModule.register({})],
  controllers: [LocationController],
  providers: [LocationService, LocationGateway, ExcludedDriversStore],
  exports: [LocationService, LocationGateway, ExcludedDriversStore],
})
export class LocationModule {}
