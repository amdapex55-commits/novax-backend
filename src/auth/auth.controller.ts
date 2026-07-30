import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { RequestOtpDto } from "./dto/request-otp.dto";
import { VerifyOtpDto } from "./dto/verify-otp.dto";
import { RefreshDto } from "./dto/refresh.dto";

@ApiTags("auth")
@Controller("api/v1/auth")
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post("otp/request")
  @ApiOperation({ summary: "Request a 6-digit login code by SMS" })
  // Tight limit: 3 requests / 5 min per IP — OTP endpoints are the classic
  // target for SMS-bombing abuse that racks up a real SMS-provider bill.
  @Throttle({ default: { limit: 3, ttl: 300000 } })
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.authService.requestOtp(dto.phone);
  }

  @Post("otp/verify")
  @ApiOperation({ summary: "Verify the code, receive access + refresh tokens" })
  @Throttle({ default: { limit: 5, ttl: 300000 } })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.phone, dto.code);
  }

  @Post("refresh")
  @ApiOperation({ summary: "Exchange a refresh token for a new token pair" })
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }
}
