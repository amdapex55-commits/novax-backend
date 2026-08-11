import { IsIn, IsNumber, IsString, MaxLength, Min } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class WithdrawDto {
  @ApiProperty({ example: 2000, description: "Amount in PKR. Cannot exceed the current balance." })
  @IsNumber()
  @Min(1)
  amount: number;

  @ApiProperty({ example: "JAZZCASH", enum: ["JAZZCASH", "EASYPAISA", "BANK"] })
  @IsIn(["JAZZCASH", "EASYPAISA", "BANK"])
  method: string;

  @ApiProperty({ example: "03001234567", description: "Mobile wallet number, or account number for a bank transfer." })
  @IsString()
  @MaxLength(40)
  destination: string;
}
