import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class UpdateVehicleDto {
  @ApiProperty({ example: "bike", enum: ["bike", "rickshaw", "car"] })
  @IsIn(["bike", "rickshaw", "car"])
  vehicleType: string;

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
}
