import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { CurrentUser } from "./current-user.decorator";
import { LoyaltyService } from "./loyalty.service";

@ApiTags("loyalty")
@ApiBearerAuth()
@Controller("api/v1/loyalty")
@UseGuards(JwtAuthGuard)
export class LoyaltyController {
  constructor(private loyaltyService: LoyaltyService) {}

  @Get("me")
  getMine(@CurrentUser() user: { userId: string }) {
    return this.loyaltyService.getLoyalty(user.userId);
  }
}
