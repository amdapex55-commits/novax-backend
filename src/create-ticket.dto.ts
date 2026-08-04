import { IsString, MaxLength, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CreateTicketDto {
  @ApiProperty({ example: "Driver went the wrong way" })
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  subject: string;

  @ApiProperty({ example: "My driver took a much longer route than expected on trip #1234." })
  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  message: string;
}
