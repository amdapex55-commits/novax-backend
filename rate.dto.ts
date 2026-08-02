import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class RateDto {
  @ApiProperty({ minimum: 1, maximum: 5, example: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  score: number;

  @ApiPropertyOptional({ example: "Great ride, on time" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}
