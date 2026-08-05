import { IsOptional, IsString, MaxLength } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: "Ahmed Khan" })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;
}
