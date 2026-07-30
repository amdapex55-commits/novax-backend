import { IsPhoneNumber } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class RequestOtpDto {
  @ApiProperty({ example: "+923001234567" })
  @IsPhoneNumber() // requires a region-agnostic E.164 number, e.g. +923001234567
  phone: string;
}
