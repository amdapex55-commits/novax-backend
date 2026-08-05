import { IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class TrackEventDto {
  @ApiProperty({ example: "ride_requested" })
  @IsString()
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ example: { vehicleType: "BIKE" } })
  @IsOptional()
  @IsObject()
  props?: Record<string, unknown>;
}
