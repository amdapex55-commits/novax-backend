import { IsEnum, IsString, Matches, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export enum UploadPurpose {
  KYC_DOC = "kyc-doc",
  PROOF_OF_DELIVERY = "proof-of-delivery",
  PROFILE_PHOTO = "profile-photo",
}

// Whitelist, not a free-text mime type field — an open string here would let a
// client ask you to presign a URL for uploading anything (e.g. an .html or
// .exe) into a bucket that's meant to hold photos/PDFs only.
const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export class PresignUploadDto {
  @ApiProperty({ enum: UploadPurpose })
  @IsEnum(UploadPurpose)
  purpose: UploadPurpose;

  // Built via the RegExp constructor (not a /.../ literal), so "/" needs no
  // escaping here — escaping it would only matter for literal regex syntax.
  @ApiProperty({ example: "image/jpeg", enum: ALLOWED_CONTENT_TYPES })
  @IsString()
  @Matches(new RegExp(`^(${ALLOWED_CONTENT_TYPES.join("|")})$`), {
    message: `contentType must be one of: ${ALLOWED_CONTENT_TYPES.join(", ")}`,
  })
  contentType: string;

  @ApiProperty({ example: "cnic-front.jpg", description: "Original filename, used only to keep a readable extension" })
  @IsString()
  @MaxLength(120)
  fileName: string;
}
