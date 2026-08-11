import { IsIn, IsOptional, IsPhoneNumber, IsString, Length } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class RequestOtpDto {
  @ApiProperty({ example: "+923001234567" })
  @IsPhoneNumber() // requires a region-agnostic E.164 number, e.g. +923001234567
  phone: string;

  @ApiPropertyOptional({ example: "AB12CD", description: "Another user's referral code, if they were referred. Only applied on first signup." })
  @IsOptional()
  @IsString()
  @Length(4, 12)
  referralCode?: string;

  // Which "front door" this signup came through — the rider app's default
  // Sign In, the "Drive with Nova Go" flow, or "List your restaurant". Only
  // read on first signup (see auth.service.requestOtp); an existing account
  // can't change its own role by re-requesting an OTP with a different value.
  @ApiPropertyOptional({ example: "DRIVER", enum: ["DRIVER", "RESTAURANT"] })
  @IsOptional()
  @IsIn(["DRIVER", "RESTAURANT"])
  role?: "DRIVER" | "RESTAURANT";
}
