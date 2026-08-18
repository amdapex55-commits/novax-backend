import { IsString, MaxLength, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ViewDocumentDto {
  /**
   * The stored reference: an object key like `kyc-doc/<userId>/<uuid>.jpg`,
   * or a legacy absolute pub-….r2.dev URL from before the bucket was locked
   * down. The service validates the shape and refuses anything outside a
   * known private purpose.
   */
  @ApiProperty({ example: "kyc-doc/9f1c…/8ab2….jpg" })
  @IsString()
  @MinLength(8)
  @MaxLength(500)
  key: string;
}
