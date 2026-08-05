import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { UsersService } from "./users.service";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UpdateVehicleDto } from "./dto/update-vehicle.dto";
import { SetModeDto } from "./dto/set-mode.dto";
import { DriverOnboardingDto, AdminDriverReviewDto } from "./dto/driver-onboarding.dto";
import { RejectKycDto } from "./dto/reject-kyc.dto";

@ApiTags("users")
@ApiBearerAuth()
@Controller("api/v1/users")
@UseGuards(JwtAuthGuard, RolesGuard) // every route below requires a valid access token
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get("me")
  getMe(@CurrentUser() user: { userId: string }) {
    return this.usersService.getProfile(user.userId);
  }

  @Patch("me")
  updateMe(@CurrentUser() user: { userId: string }, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(user.userId, dto);
  }

  @Get("me/vehicle")
  @Roles("DRIVER")
  getVehicle(@CurrentUser() user: { userId: string }) {
    return this.usersService.getVehicle(user.userId);
  }

  @Patch("me/vehicle")
  @Roles("DRIVER")
  updateVehicle(@CurrentUser() user: { userId: string }, @Body() dto: UpdateVehicleDto) {
    return this.usersService.upsertVehicle(user.userId, dto);
  }

  @Patch("me/mode")
  @Roles("DRIVER")
  setMode(@CurrentUser() user: { userId: string }, @Body() dto: SetModeDto) {
    return this.usersService.setActiveMode(user.userId, dto);
  }

  // --- Driver onboarding (self-service side) ---

  @Get("me/onboarding")
  @Roles("DRIVER")
  @ApiOperation({ summary: "Onboarding progress + what's still missing" })
  getOnboarding(@CurrentUser() user: { userId: string }) {
    return this.usersService.getOnboardingStatus(user.userId);
  }

  @Patch("me/onboarding")
  @Roles("DRIVER")
  @ApiOperation({ summary: "Save onboarding details (partial saves allowed)" })
  saveOnboarding(@CurrentUser() user: { userId: string }, @Body() dto: DriverOnboardingDto) {
    return this.usersService.saveOnboarding(user.userId, dto);
  }

  @Post("me/onboarding/submit")
  @Roles("DRIVER")
  @ApiOperation({ summary: "Submit the completed application for human review" })
  submitOnboarding(@CurrentUser() user: { userId: string }) {
    return this.usersService.submitForReview(user.userId);
  }

  // --- Ops review side ---

  @Get(":id/application")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Full driver application for the ops review screen" })
  getApplication(@Param("id") id: string) {
    return this.usersService.getDriverApplication(id);
  }

  @Patch(":id/review")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Internal ops notes + training checklist" })
  review(@Param("id") id: string, @Body() dto: AdminDriverReviewDto) {
    return this.usersService.adminReviewDriver(id, dto);
  }

  @Post(":id/approve-kyc")
  @Roles("ADMIN")
  approveKyc(@Param("id") id: string) {
    return this.usersService.approveDriverKyc(id);
  }

  @Post(":id/reject-kyc")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Reject with a reason the driver actually sees" })
  rejectKyc(@Param("id") id: string, @Body() dto: RejectKycDto) {
    return this.usersService.rejectDriverKyc(id, dto.reason);
  }
}
