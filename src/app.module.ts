import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { ThrottlerStorageRedisService } from "nestjs-throttler-storage-redis";
import { APP_GUARD } from "@nestjs/core";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { RedisService } from "./redis/redis.service";
import { HealthModule } from "./health/health.module";
import { LaunchModule } from "./launch/launch.module";
import { ServiceEnabledGuard } from "./launch/requires-service.decorator";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { LocationModule } from "./location/location.module";
import { TripsModule } from "./trips/trips.module";
import { DeliveryModule } from "./delivery/delivery.module";
import { UploadsModule } from "./uploads/uploads.module";
import { LedgerModule } from "./ledger/ledger.module";
import { RatingsModule } from "./ratings/ratings.module";
import { LoyaltyModule } from "./loyalty/loyalty.module";
import { PushModule } from "./push/push.module";
import { ReviewFleetModule } from "./review-fleet/review-fleet.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { AdminModule } from "./admin/admin.module";
import { SupportModule } from "./support/support.module";
import { BusinessModule } from "./business/business.module";
import { RestaurantsModule } from "./restaurants/restaurants.module";
import { FoodOrdersModule } from "./food-orders/food-orders.module";
import { ErrandsModule } from "./errands/errands.module";
import { ChatModule } from "./chat/chat.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { SafetyModule } from "./safety/safety.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global default: 20 requests / 60s per IP. Auth endpoints override this
    // with tighter limits (see auth.controller.ts) since OTP abuse costs real money.
    //
    // Counters live in Redis, not in process memory. In-memory counters are
    // worse than no rate limit at all here, because they look like protection:
    // with N replicas an attacker gets N x the limit, and every deploy or
    // restart resets everyone's counter to zero. For the OTP endpoints that
    // difference is billable — each retry is a real SMS.
    //
    // This shares the connection RedisService already owns rather than opening
    // a second one; passing an existing client also means the throttler won't
    // tear that connection down on module destroy.
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [{ ttl: 60000, limit: 20 }],
        storage: new ThrottlerStorageRedisService(redis.client),
      }),
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    LaunchModule,
    AuthModule,
    UsersModule,
    LocationModule,
    TripsModule,
    DeliveryModule,
    UploadsModule,
    LedgerModule,
    RatingsModule,
    LoyaltyModule,
    PushModule,
    ReviewFleetModule,
    NotificationsModule,
    AdminModule,
    SupportModule,
    BusinessModule,
    RestaurantsModule,
    FoodOrdersModule,
    ErrandsModule,
    ChatModule,
    AnalyticsModule,
    SafetyModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global so a parked service can't come back online just because
    // someone forgot to add a guard to a new controller.
    { provide: APP_GUARD, useClass: ServiceEnabledGuard },
  ],
})
export class AppModule {}
