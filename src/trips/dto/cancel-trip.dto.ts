import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Fixed reason codes, not free text.
 *
 * A free-text box produces "cancel", "cancelled", "1" and nothing you can
 * group by. These are the reasons that actually change what ops does:
 *
 *   DRIVER_TOO_FAR / LONG_WAIT   — a matching problem
 *   WRONG_PICKUP                 — the GPS accuracy gate, or an address the
 *                                  customer couldn't describe
 *   DRIVER_ASKED_MORE            — a rider breaking the fixed-fare promise.
 *                                  This one ends a relationship, so it has to
 *                                  be countable per driver.
 *   CHANGED_MIND / BOOKED_MISTAKE — no fault, and worth separating from the
 *                                  above so they don't inflate a real problem.
 */
export const CANCEL_REASONS = [
  "DRIVER_TOO_FAR",
  "LONG_WAIT",
  "WRONG_PICKUP",
  "DRIVER_ASKED_MORE",
  "CHANGED_MIND",
  "BOOKED_BY_MISTAKE",
  "OTHER",
] as const;

export class CancelTripDto {
  @ApiProperty({ enum: CANCEL_REASONS })
  @IsIn(CANCEL_REASONS as unknown as string[])
  reason: (typeof CANCEL_REASONS)[number];

  @ApiPropertyOptional({ example: "Rider called and asked for Rs 100 extra" })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
