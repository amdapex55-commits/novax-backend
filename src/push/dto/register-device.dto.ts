import { IsIn, IsString, MaxLength, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class RegisterDeviceDto {
  // FCM tokens are ~150-200 chars. These bounds are a sanity check, not a
  // format check — Google changes the token shape periodically, and a strict
  // regex here would start rejecting real devices on their schedule.
  @ApiProperty({ description: "FCM registration token" })
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  token: string;

  @ApiProperty({ enum: ["android", "ios", "web"] })
  @IsIn(["android", "ios", "web"])
  platform: string;

  // Which Nova Go app this install is. Required, never defaulted: a phone with
  // both apps installed has two tokens for one person, and guessing wrong
  // delivers a driver's job offer to the customer app.
  @ApiProperty({ enum: ["customer", "driver", "merchant", "ops"] })
  @IsIn(["customer", "driver", "merchant", "ops"])
  app: string;
}
