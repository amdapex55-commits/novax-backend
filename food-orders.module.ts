import { Module } from "@nestjs/common";
import { FoodOrdersService } from "./food-orders.service";
import { FoodOrdersController } from "./food-orders.controller";
import { LocationModule } from "./location.module";
import { LedgerModule } from "./ledger.module";
import { RatingsModule } from "./ratings.module";
import { LoyaltyModule } from "./loyalty.module";
import { NotificationsModule } from "./notifications.module";

@Module({
  imports: [LocationModule, LedgerModule, RatingsModule, LoyaltyModule, NotificationsModule],
  controllers: [FoodOrdersController],
  providers: [FoodOrdersService],
})
export class FoodOrdersModule {}
