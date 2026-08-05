import { IsIn, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ManualAssignDto {
  @ApiProperty({ enum: ["TRIP", "DELIVERY", "FOOD_ORDER", "ERRAND"] })
  @IsIn(["TRIP", "DELIVERY", "FOOD_ORDER", "ERRAND"])
  jobType: "TRIP" | "DELIVERY" | "FOOD_ORDER" | "ERRAND";

  @ApiProperty()
  @IsString()
  jobId: string;

  @ApiProperty()
  @IsString()
  driverId: string;
}
