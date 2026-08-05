import { IsIn, IsLatitude, IsLongitude, IsOptional, IsString, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateIncidentDto {
  @ApiPropertyOptional({ enum: ["SOS", "ACCIDENT", "HARASSMENT", "VEHICLE_BREAKDOWN", "OTHER"] })
  @IsOptional()
  @IsIn(["SOS", "ACCIDENT", "HARASSMENT", "VEHICLE_BREAKDOWN", "OTHER"])
  type?: "SOS" | "ACCIDENT" | "HARASSMENT" | "VEHICLE_BREAKDOWN" | "OTHER";

  @ApiPropertyOptional({ enum: ["TRIP", "DELIVERY", "FOOD_ORDER", "ERRAND"] })
  @IsOptional()
  @IsIn(["TRIP", "DELIVERY", "FOOD_ORDER", "ERRAND"])
  contextType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contextId?: string;

  // Optional because a phone can deny location permission at the worst
  // possible moment — an SOS with no coordinates still has to be recorded.
  @ApiPropertyOptional({ example: 24.8607 })
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: 67.0011 })
  @IsOptional()
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({ example: "Driver is taking a different route" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ResolveIncidentDto {
  @ApiProperty({ enum: ["ACKNOWLEDGED", "RESOLVED"] })
  @IsIn(["ACKNOWLEDGED", "RESOLVED"])
  status: "ACKNOWLEDGED" | "RESOLVED";

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  resolution?: string;
}
