import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class UpdateRestaurantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  lng?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cuisineTags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bannerUrl?: string;

  // --- Ops settings ---

  // Feeds the customer-facing ETA. Capped at 2 hours because anything longer
  // isn't a prep time, it's a scheduling feature that doesn't exist yet.
  @ApiPropertyOptional({ example: 20, description: "Typical kitchen prep time in minutes" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  prepTimeMinutes?: number;

  // The number ops rings when an order sits unaccepted — often the kitchen
  // landline rather than the owner's login phone.
  @ApiPropertyOptional({ example: "+923001234567" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  notifyPhone?: string;

  @ApiPropertyOptional({ enum: ["JAZZCASH", "EASYPAISA", "BANK"] })
  @IsOptional()
  @IsIn(["JAZZCASH", "EASYPAISA", "BANK"])
  payoutMethod?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  payoutAccountName?: string;

  // Payout destination only — see the same note on the driver DTO.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  payoutAccountNumber?: string;
}
