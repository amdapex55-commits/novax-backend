import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Password signup.
 *
 * WHY THIS EXISTS ALONGSIDE OTP
 *
 * OTP login is built and works, but it needs a provisioned SMS sender, and a
 * local aggregator mask takes weeks to approve. Nobody can sign up in the
 * meantime. So this is the interim door: a password.
 *
 * The OTP endpoints are deliberately NOT deleted. When SMS is live, both flows
 * run side by side — `passwordHash` is nullable precisely so an OTP-created
 * account is valid without one.
 */
export class RegisterDto {
  @ApiProperty({ example: "Ahmed" })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  firstName: string;

  @ApiProperty({ example: "Khan" })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  lastName: string;

  @ApiProperty({ example: "+923001234567", description: "Pakistani mobile number." })
  @IsString()
  @MaxLength(20)
  phone: string;

  @ApiProperty({ example: "ahmed@example.com" })
  @IsEmail({}, { message: "Enter a valid email address" })
  @MaxLength(120)
  email: string;

  /**
   * Eight characters, no composition rules.
   *
   * Length does far more for real-world password strength than forcing a
   * symbol, and complexity rules mostly produce "Password1!" plus a support
   * call. This is an interim credential for a market where many users are
   * typing on a phone keyboard in the sun.
   */
  @ApiProperty({ example: "a-good-password", minLength: 8 })
  @IsString()
  @MinLength(8, { message: "Password must be at least 8 characters" })
  @MaxLength(128)
  password: string;

  @ApiProperty({ enum: ["RIDER", "DRIVER"], default: "RIDER" })
  @IsOptional()
  @IsIn(["RIDER", "DRIVER"])
  role?: "RIDER" | "DRIVER";

  // ---- Driver-only fields. Ignored for a customer signup. ----

  @ApiPropertyOptional({ example: "House 12, Street 4, Gulshan-e-Iqbal, Karachi" })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  address?: string;

  @ApiPropertyOptional({ description: "R2 URL from the presigned upload flow — front of the driving licence." })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  licenseFrontUrl?: string;

  @ApiPropertyOptional({ description: "R2 URL — back of the driving licence." })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  licenseBackUrl?: string;
}

export class LoginDto {
  @ApiProperty({
    example: "ahmed@example.com",
    description: "Email address or phone number — whichever they remember.",
  })
  @IsString()
  @MaxLength(120)
  identifier: string;

  @ApiProperty({ example: "a-good-password" })
  @IsString()
  @MaxLength(128)
  password: string;
}
