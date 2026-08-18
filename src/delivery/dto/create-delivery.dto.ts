import { IsLatitude, IsLongitude, IsNumber, IsOptional, IsPositive, IsPhoneNumber, IsString, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateDeliveryDto {
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

  /* The addresses as the sender wrote them. Optional because a pin dropped on
     a map has no name, but sent whenever the sender picked a place — without
     them the driver's job screen can only say "Pickup point". */
  @ApiPropertyOptional({ example: "Tariq Road, Karachi" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  pickupLabel?: string;

  @ApiPropertyOptional({ example: "DHA Phase 5, Karachi" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  dropoffLabel?: string;

  @ApiProperty({ example: "Ayesha Malik" })
  @IsString()
  @MaxLength(80)
  recipientName: string;

  @ApiProperty({ example: "+923001234567" })
  @IsPhoneNumber()
  recipientPhone: string;

  @ApiPropertyOptional({ example: "Small box, handle with care" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  parcelNote?: string;

  @ApiPropertyOptional({ description: "Cash the driver should collect from the recipient, if any", example: 1500 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  codAmount?: number;
}
