import { IsArray, IsNumber, IsOptional, IsString, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateRestaurantDto {
  @ApiProperty({ example: "Karachi Karahi House" })
  @IsString()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ example: "Home-style Karahi, BBQ, and biryani since 1998" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: "Shop 4, Zamzama Blvd, Karachi" })
  @IsString()
  @MaxLength(200)
  address: string;

  @ApiProperty({ example: 24.8607 })
  @IsNumber()
  lat: number;

  @ApiProperty({ example: 67.0011 })
  @IsNumber()
  lng: number;

  @ApiPropertyOptional({ example: ["Pakistani", "BBQ"] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cuisineTags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bannerUrl?: string;
}
