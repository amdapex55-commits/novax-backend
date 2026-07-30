import { IsPhoneNumber, Length } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class VerifyOtpDto {
  @ApiProperty({ example: "+923001234567" })
  @IsPhoneNumber()
  phone: string;

  @ApiProperty({ example: "123456" })
  @Length(6, 6)
  code: string;
}
