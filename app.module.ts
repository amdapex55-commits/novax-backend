import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { PrismaModule } from "./prisma.module";
import { RedisModule } from "./redis.module";
import { AuthModule } from "./auth.module";
import { UsersModule } from "./users.module";
import { LocationModule } from "./location.module";
import { TripsModule } from "./trips.module";
import { DeliveryModule } from "./delivery.module";
import { UploadsModule } from "./uploads.module";
import { LedgerModule } from "./ledger.module";
import { RatingsModule } from "./ratings.module";
import { LoyaltyModule } from "./loyalty.module";
import { NotificationsModule } from "./notifications.module";
import { AdminModule } from "./admin.module";
import { SupportModule } from "./support.module";
import { BusinessModule } from "./business.module";
import { RestaurantsModule } from "./restaurants.module";
import { FoodOrdersModule } from "./food-orders.module";
import { ErrandsModule } from "./errands.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global default: 20 requests / 60s per IP. Auth endpoints override this
    // with tighter limits (see auth.controller.ts) since OTP abuse costs real money.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 20 }]),
    PrismaModule,
    RedisModule,
    AuthModule,
    UsersModule,
    LocationModule,
    TripsModule,
    DeliveryModule,
    UploadsModule,
    LedgerModule,
    RatingsModule,
    LoyaltyModule,
    NotificationsModule,
    AdminModule,
    SupportModule,
    BusinessModule,
    RestaurantsModule,
    FoodOrdersModule,
    ErrandsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
