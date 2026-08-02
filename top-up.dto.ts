import { IsNumber, IsPositive, Max } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class TopUpDto {
  @ApiProperty({ example: 500, description: "Amount to add to the caller's own wallet balance (PKR)." })
  @IsNumber()
  @IsPositive()
  @Max(500000) // sanity ceiling — no payment gateway is behind this yet
  amount: number;
}
