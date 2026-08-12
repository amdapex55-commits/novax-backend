import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class DeletionRequestDto {
  @ApiProperty({
    example: "+923001234567",
    description: "The phone number or email the account was created with.",
  })
  @IsString()
  @MinLength(5)
  @MaxLength(120)
  contact: string;

  @ApiPropertyOptional({ example: "I no longer use the service." })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
