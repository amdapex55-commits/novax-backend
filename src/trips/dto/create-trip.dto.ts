import { IsEnum, IsLatitude, IsLongitude, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from "class-validator";
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

  /**
   * ROAD distance in km, from the client's routing engine (OSRM).
   *
   * Sent by the client because the client already computed it to draw the
   * route line and show the fare — asking the server to route again would
   * double the calls to the routing host and could produce a different
   * number than the one the customer just agreed to.
   *
   * The server does NOT trust it blindly: it's sanity-checked against the
   * straight-line distance in trips.service (a road route can't be shorter
   * than the crow-flies distance, and shouldn't be more than ~3× it). A
   * value outside that band is discarded and the server recomputes its own
   * estimate — otherwise a modified client could send distanceKm: 0.1 and
   * ride across the city for the minimum fare.
   */
  @ApiPropertyOptional({ description: "Road distance in km from the routing engine", example: 6.2 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  roadDistanceKm?: number;

  @ApiPropertyOptional({ description: "Road duration in minutes from the routing engine", example: 18 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  roadDurationMinutes?: number;

  @ApiPropertyOptional({ example: "Neeli building, gate ke saamne" })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  pickupNote?: string;

  @ApiPropertyOptional({ description: "R2 URL of a short voice note from the customer" })
  @IsOptional()
  @IsString()
  pickupNoteAudioUrl?: string;

  /** GPS accuracy of the pickup in metres, as reported by the device. */
  @ApiPropertyOptional({ description: "Pickup GPS accuracy in metres", example: 18 })
  @IsOptional()
  @IsNumber()
  pickupAccuracyMeters?: number;
}
