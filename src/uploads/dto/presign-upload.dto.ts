import { IsEnum, IsString, Matches, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export enum UploadPurpose {
  KYC_DOC = "kyc-doc",
  PROOF_OF_DELIVERY = "proof-of-delivery",
  PROFILE_PHOTO = "profile-photo",
  // Storefront imagery. Separate purposes from PROFILE_PHOTO because these
  // are PUBLIC — every customer browsing food sees them — whereas a KYC doc
  // must never be. Keeping them in distinct key prefixes means bucket-level
  // access rules can differ without any code branching on filename.
  RESTAURANT_LOGO = "restaurant-logo",
  RESTAURANT_BANNER = "restaurant-banner",
  MENU_ITEM = "menu-item",
  // Short voice note from a customer describing their exact pickup point.
  // Karachi addresses are spoken, not written — "gate ke saamne" gets a rider
  // to your door in a way a GPS pin cannot.
  PICKUP_NOTE = "pickup-note",
}

// Whitelist, not a free-text mime type field — an open string here would let a
// client ask you to presign a URL for uploading anything (e.g. an .html or
// .exe) into a bucket that's meant to hold photos/PDFs only.
const ALLOWED_CONTENT_TYPES = [
  "image/jpeg", "image/png", "image/webp", "application/pdf",
  // WHAT PHONES ACTUALLY SEND.
  //
  // The list above is what a developer types. It is not what a camera
  // produces, and every one of these was rejected in production while the
  // driver saw only "Failed, tap to retry":
  //
  //   image/heic, image/heif  every photo in an iPhone library
  //   image/jpg               some Android cameras; not a real mime type
  //   image/pjpeg             older Android WebViews
  //
  // The client converts to JPEG where the browser can decode the file, but
  // Android Chrome cannot decode HEIC at all, so conversion is impossible on
  // exactly the device combination that needs it most. Accepting these is
  // what makes the upload work there.
  //
  // This is still a whitelist — the point of it is that nobody can presign a
  // URL for an .html or an .exe, and that is untouched.
  "image/heic", "image/heif", "image/jpg", "image/pjpeg",
  // Voice pickup notes. Browsers pick their own container: Chrome/Android
  // give webm, Safari gives mp4/aac. Both are accepted so the feature isn't
  // silently iOS-only.
  "audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg",
];

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
