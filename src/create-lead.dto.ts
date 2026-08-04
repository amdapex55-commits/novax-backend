import { IsEmail, IsOptional, IsPhoneNumber, IsString, MaxLength, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateLeadDto {
  @ApiProperty({ example: "Acme Logistics" })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  companyName: string;

  @ApiProperty({ example: "Ayesha Malik" })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  contactName: string;

  @ApiProperty({ example: "+923001234567" })
  @IsPhoneNumber()
  phone: string;

  @ApiPropertyOptional({ example: "ayesha@acme.com" })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: "Need ~50 deliveries/day across Karachi" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
