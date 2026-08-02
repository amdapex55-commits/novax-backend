import { IsNumber, IsString, MaxLength, Min } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CreateErrandDto {
  @ApiProperty({ example: "Imtiaz Super Market, Tariq Road" })
  @IsString()
  @MaxLength(150)
  storeLabel: string;

  @ApiProperty({ example: 24.8725 })
  @IsNumber()
  storeLat: number;

  @ApiProperty({ example: 67.0644 })
  @IsNumber()
  storeLng: number;

  @ApiProperty({ example: "House 12, Street 4, DHA Phase 6" })
  @IsString()
  @MaxLength(200)
  dropoffLabel: string;

  @ApiProperty({ example: 24.8138 })
  @IsNumber()
  dropoffLat: number;

  @ApiProperty({ example: 67.0304 })
  @IsNumber()
  dropoffLng: number;

  @ApiProperty({ example: "2x milk (1L), 1 dozen eggs, a small pack of AA batteries" })
  @IsString()
  @MaxLength(500)
  itemsDescription: string;

  @ApiProperty({ example: 2000 })
  @IsNumber()
  @Min(0)
  estimatedBudget: number;
}
