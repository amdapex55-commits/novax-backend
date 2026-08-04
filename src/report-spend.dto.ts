import { IsNumber, Min } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

// Driver reports what they actually spent in-store once shopping is done —
// may differ from the requester's estimatedBudget in either direction.
export class ReportSpendDto {
  @ApiProperty({ example: 1840 })
  @IsNumber()
  @Min(0)
  actualSpend: number;
}
