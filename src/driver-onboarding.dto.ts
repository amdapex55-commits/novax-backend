import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

// Everything a human reviewer needs before flipping a driver to APPROVED.
// All optional individually so the driver can save progress and come back —
// completeness is checked at submit time (see UsersService.submitForReview),
// not field-by-field here.
export class DriverOnboardingDto {
  @ApiPropertyOptional({ enum: ["bike", "rickshaw", "car"] })
  @IsOptional()
  @IsIn(["bike", "rickshaw", "car"])
  vehicleType?: string;

  @ApiPropertyOptional({ example: "KHI-2024" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  vehiclePlate?: string;

  @ApiPropertyOptional({ example: "42101-1234567-1" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  cnicNumber?: string;

  // R2 object URLs produced by the presigned-upload flow (uploads module).
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cnicFrontUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cnicBackUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  licenseDocUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehicleDocUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehiclePhotoUrl?: string;

  @ApiPropertyOptional({ example: "DHA / Clifton" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  serviceZone?: string;

  @ApiPropertyOptional({ enum: ["JAZZCASH", "EASYPAISA", "BANK"] })
  @IsOptional()
  @IsIn(["JAZZCASH", "EASYPAISA", "BANK"])
  payoutMethod?: string;

  @ApiPropertyOptional({ example: "Ahmed Khan" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  payoutAccountName?: string;

  // A payout DESTINATION, not a payment credential — this is where the
  // platform sends money the driver has already earned, the same way you'd
  // write it on an invoice. Nothing here can be used to charge anyone.
  @ApiPropertyOptional({ example: "03001234567" })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  payoutAccountNumber?: string;

  @ApiPropertyOptional({ example: "Fatima Khan" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  emergencyContactName?: string;

  @ApiPropertyOptional({ example: "+923001234567" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  emergencyContactPhone?: string;
}

// Admin-only fields — a driver must never be able to mark their own training
// complete or write their own ops notes.
export class AdminDriverReviewDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  onboardingNotes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trainingCompleted?: boolean;
}
