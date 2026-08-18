import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Analytics props must be a flat bag of primitives.
 *
 * At most 25 keys, keys limited to word characters, values limited to string
 * / number / boolean / null, and strings capped. Keys beginning with `$` or
 * containing `.` are refused outright — they carry meaning to document stores
 * and query builders and have no business arriving from an anonymous caller.
 */
@ValidatorConstraint({ name: "FlatPrimitiveProps" })
export class FlatPrimitiveProps implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== "object" || Array.isArray(value)) return false;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 25) return false;
    return entries.every(([k, v]) => {
      if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) return false;
      if (v === null) return true;
      const t = typeof v;
      if (t === "number") return Number.isFinite(v as number);
      if (t === "boolean") return true;
      if (t === "string") return (v as string).length <= 200;
      return false;
    });
  }

  defaultMessage(): string {
    return "props must be a flat object of at most 25 primitive values with simple keys";
  }
}

export class TrackEventDto {
  @ApiProperty({ example: "ride_requested" })
  @IsString()
  @MaxLength(60)
  name: string;

  /* AN UNAUTHENTICATED ENDPOINT THAT ACCEPTED ARBITRARY JSON.
     This is the one route anyone on the internet can post to without a token,
     and its payload lands in a JSONB column. @IsObject alone permits any
     depth, any key and any value — so it accepted operator-shaped keys, deep
     nesting that costs the database real work to index, and megabytes of
     junk. Analytics props are a flat bag of primitives; nothing legitimate
     needs more than that. */
  @ApiPropertyOptional({ example: { vehicleType: "BIKE" } })
  @IsOptional()
  @IsObject()
  @Validate(FlatPrimitiveProps)
  props?: Record<string, unknown>;
}
