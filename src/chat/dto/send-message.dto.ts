import { IsString, Length } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class SendMessageDto {
  @ApiProperty({ example: "I'm right outside the gate" })
  @IsString()
  @Length(1, 1000)
  body: string;
}
