import { IsNumber, IsString, Max, MaxLength, Min } from "class-validator";
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

  /**
   * What the driver will have to front, in cash, from their own pocket.
   *
   * Capped, because this is the one job type where the platform asks a rider
   * to spend their own money before being repaid. An uncapped errand can ask
   * someone earning Rs 250 a trip to lay out Rs 15,000 at a supermarket till —
   * which they either can't do, or can do once and then can't work for the
   * rest of the day. The cap is the difference between an errand being a job
   * and being a loan.
   */
  @ApiProperty({ example: 2000, maximum: 2000 })
  @IsNumber()
  @Min(0)
  @Max(2000)
  estimatedBudget: number;
}
