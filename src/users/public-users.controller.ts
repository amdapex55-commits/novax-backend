import { Body, Controller, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { UsersService } from "./users.service";
import { DeletionRequestDto } from "./dto/deletion-request.dto";
import { PasswordResetRequestDto } from "./dto/password-reset-request.dto";

/**
 * Deliberately NOT guarded, and deliberately a separate controller.
 *
 * UsersController applies JwtAuthGuard at the class level, which is correct
 * for everything in it. This one route has to work for someone who has
 * already uninstalled the app and cannot authenticate — which is exactly the
 * person Google Play's deletion policy is about. Rather than punching a hole
 * in a guarded controller (the kind of exception that gets copied onto the
 * next route by accident), the unauthenticated surface lives in its own file
 * where it is obvious.
 */
@ApiTags("users")
@Controller("api/v1/users")
export class PublicUsersController {
  constructor(private usersService: UsersService) {}

  // Rate-limited: unauthenticated and it writes a row.
  @Post("deletion-request")
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @ApiOperation({ summary: "Request account deletion without signing in (public web form)" })
  requestDeletion(@Body() dto: DeletionRequestDto) {
    return this.usersService.requestDeletion(dto.contact, dto.note);
  }

  // Same shape and the same reason for being unauthenticated: the person who
  // needs this is by definition the person who cannot sign in. Rate-limited
  // harder than deletion — a password form is the more attractive one to
  // probe, and this one writes a row ops has to read.
  @Post("password-reset-request")
  @Throttle({ default: { limit: 3, ttl: 600_000 } })
  @ApiOperation({ summary: "Ask ops to reset a password without signing in" })
  requestPasswordReset(@Body() dto: PasswordResetRequestDto) {
    return this.usersService.requestPasswordReset(dto.contact, dto.note);
  }
}
