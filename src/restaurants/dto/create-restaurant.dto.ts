import {
  IsArray, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString,
  Max, MaxLength, Min,
} from "class-validator";
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

  // --- Storefront details ---
  // Collected at signup rather than left for later, because a storefront
  // missing hours or a contact number can't actually go live — and chasing
  // them by phone afterwards is the slowest part of onboarding a kitchen.

  @ApiPropertyOptional({ example: "Imran Sheikh" })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  ownerName?: string;

  @ApiPropertyOptional({ example: "+923001234567" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  ownerPhone?: string;

  @ApiPropertyOptional({ example: "+923001234567", description: "Number ops calls about live orders" })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  notifyPhone?: string;

  @ApiPropertyOptional({ example: 25, description: "Typical minutes from accept to ready" })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(120)
  prepTimeMinutes?: number;

  @ApiPropertyOptional({
    example: { mon: { open: "11:00", close: "23:00", closed: false } },
    description: "Weekly opening hours keyed by mon..sun",
  })
  @IsOptional()
  @IsObject()
  openingHours?: Record<string, { open: string; close: string; closed: boolean }>;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(25)
  deliveryRadiusKm?: number;

  @ApiPropertyOptional({ example: 300 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderValue?: number;

  // Payout DESTINATION, not a payment credential. We never take or store a
  // card, CVV or PIN — this is where the restaurant's weekly share is sent.
  @ApiPropertyOptional({ enum: ["JAZZCASH", "EASYPAISA", "BANK"] })
  @IsOptional()
  @IsIn(["JAZZCASH", "EASYPAISA", "BANK"])
  payoutMethod?: string;

  @ApiPropertyOptional({ example: "Karachi Karahi House" })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  payoutAccountName?: string;

  @ApiPropertyOptional({ example: "03001234567" })
  @IsOptional()
  @IsString()
  @MaxLength(34)
  payoutAccountNumber?: string;
}
