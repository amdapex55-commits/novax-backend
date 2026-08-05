import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { SmsService } from "./sms.service";
import { JwtStrategy } from "./jwt.strategy";
import { LoyaltyModule } from "../loyalty/loyalty.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [PassportModule, JwtModule.register({}), LoyaltyModule, NotificationsModule], // secrets are passed per-call in AuthService
  controllers: [AuthController],
  providers: [AuthService, SmsService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
