import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { LocationModule } from "./location/location.module";
import { TripsModule } from "./trips/trips.module";
import { DeliveryModule } from "./delivery/delivery.module";
import { UploadsModule } from "./uploads/uploads.module";
import { LedgerModule } from "./ledger/ledger.module";
import { RatingsModule } from "./ratings/ratings.module";

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
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
