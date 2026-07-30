import { IsEnum, IsLatitude, IsLongitude, IsNumber, IsOptional, IsPositive } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export enum VehicleTypeDto {
  BIKE = "BIKE",
  RICKSHAW = "RICKSHAW",
  CAR = "CAR",
}

export enum FareTypeDto {
  FIXED = "FIXED",
  BID = "BID",
}

export class CreateTripDto {
  @ApiProperty({ example: 24.8607 })
  @IsLatitude()
  pickupLat: number;

  @ApiProperty({ example: 67.0011 })
  @IsLongitude()
  pickupLng: number;

  @ApiProperty({ example: 24.8916 })
  @IsLatitude()
  dropoffLat: number;

  @ApiProperty({ example: 67.0653 })
  @IsLongitude()
  dropoffLng: number;

  @ApiProperty({ enum: VehicleTypeDto })
  @IsEnum(VehicleTypeDto)
  vehicleType: VehicleTypeDto;

  @ApiPropertyOptional({ enum: FareTypeDto, default: FareTypeDto.FIXED })
  @IsOptional()
  @IsEnum(FareTypeDto)
  fareType?: FareTypeDto;

  @ApiPropertyOptional({ description: "Required when fareType = BID", example: 250 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  offeredFare?: number;
}
