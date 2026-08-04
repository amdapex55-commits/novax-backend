import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsString, Min, MaxLength, ValidateNested } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class FoodOrderItemInputDto {
  @ApiProperty()
  @IsString()
  menuItemId: string;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  quantity: number;
}

export class CreateFoodOrderDto {
  @ApiProperty()
  @IsString()
  restaurantId: string;

  @ApiProperty({ type: [FoodOrderItemInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FoodOrderItemInputDto)
  items: FoodOrderItemInputDto[];

  @ApiProperty({ example: "House 12, Street 4, DHA Phase 6" })
  @IsString()
  @MaxLength(200)
  dropoffLabel: string;

  @ApiProperty({ example: 24.8138 })
  @IsNumber()
  dropoffLat: number;

  @ApiProperty({ example: 67.0304 })
  @IsNumber()
  dropoffLng: number;

  @ApiPropertyOptional({ example: "No onions please" })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}
