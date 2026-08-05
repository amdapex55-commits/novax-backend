import { IsOptional, IsString, MaxLength } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class SuspendUserDto {
  // Optional but strongly encouraged — this text is what the suspended person
  // actually receives as a notification, so "no reason given" becomes a
  // support call.
  @ApiPropertyOptional({ example: "Repeated cancellations after accepting rides." })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
