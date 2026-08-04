import { IsBoolean, IsNumber, IsOptional, IsString, MaxLength, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class UpsertMenuItemDto {
  @ApiProperty({ example: "Chicken Karahi (Half)" })
  @IsString()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ example: "Served with 2 naan" })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ example: 950 })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ example: "Mains" })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}
