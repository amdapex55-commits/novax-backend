import { IsOptional, IsString, MaxLength, IsEmail } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: "Ahmed" })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ example: "Khan" })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string;

  /* Email is editable; PHONE IS NOT.
     A typo'd email is a self-inflicted inconvenience the customer can fix.
     A changed phone number is an account takeover primitive: it's a login
     identifier here, so letting a signed-in session rewrite it means a
     borrowed phone becomes a permanent transfer of the account. Changing a
     number goes through support, deliberately. */
  @ApiPropertyOptional({ example: "ahmed@example.com" })
  @IsOptional()
  @IsEmail({}, { message: "Enter a valid email address" })
  @MaxLength(120)
  email?: string;
}
