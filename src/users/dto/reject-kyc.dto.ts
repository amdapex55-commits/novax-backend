import { IsString, MaxLength, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class RejectKycDto {
  // Required, not optional: a rejection with no reason is how a driver ends
  // up phoning support asking "why?" — which costs more than typing it here.
  @ApiProperty({ example: "CNIC photo was blurry — please re-upload a clear picture of both sides." })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}
