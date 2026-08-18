import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { RatingsService } from "./ratings.service";

/**
 * There was no ratings controller at all.
 *
 * Ratings were written and averaged correctly, and then nothing could read
 * them back. A driver saw a number on their profile with no way to find out
 * what it was made of, and a passenger's comment went into a table nobody
 * would ever open. This is the missing half.
 */
@ApiTags("ratings")
@ApiBearerAuth()
@Controller("api/v1/ratings")
@UseGuards(JwtAuthGuard)
export class RatingsController {
  constructor(private ratings: RatingsService) {}

  @Get("me")
  @ApiOperation({ summary: "My own rating: average, star breakdown, and the comments" })
  mine(@CurrentUser() user: { userId: string }) {
    return this.ratings.listFor(user.userId);
  }
}
