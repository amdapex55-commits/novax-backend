import { IsIn } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class SetModeDto {
  @ApiProperty({ example: "FOOD_ERRAND", enum: ["RIDE", "FOOD_ERRAND"] })
  @IsIn(["RIDE", "FOOD_ERRAND"])
  mode: "RIDE" | "FOOD_ERRAND";
}
