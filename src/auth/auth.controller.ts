import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { RequestOtpDto } from "./dto/request-otp.dto";
import { VerifyOtpDto } from "./dto/verify-otp.dto";
import { RefreshDto } from "./dto/refresh.dto";
import { RegisterDto, LoginDto } from "./dto/register.dto";

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
    return this.authService.requestOtp(dto.phone, dto.referralCode, dto.role);
  }

  @Post("otp/verify")
  @ApiOperation({ summary: "Verify the code, receive access + refresh tokens" })
  @Throttle({ default: { limit: 5, ttl: 300000 } })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.phone, dto.code);
  }

  // Signup. Rate-limited but far looser than OTP — this costs us nothing to
  // serve, unlike an SMS, and a legitimate person fat-fingering a form
  // shouldn't be locked out for five minutes.
  @Post("register")
  @ApiOperation({ summary: "Create an account with a password. Customers are active immediately; drivers await approval." })
  @Throttle({ default: { limit: 10, ttl: 300000 } })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post("login")
  @ApiOperation({ summary: "Sign in with email or phone plus password" })
  // Tighter than register: this one is worth brute-forcing.
  @Throttle({ default: { limit: 10, ttl: 300000 } })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.identifier, dto.password);
  }

  @Post("refresh")
  @ApiOperation({ summary: "Exchange a refresh token for a new token pair" })
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }
}
