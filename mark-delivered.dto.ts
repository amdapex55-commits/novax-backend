import { IsOptional, IsUrl } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class MarkDeliveredDto {
  @ApiPropertyOptional({ description: "Proof-of-delivery photo URL, uploaded to R2 client-side first" })
  @IsOptional()
  @IsUrl()
  proofOfDeliveryUrl?: string;
}
