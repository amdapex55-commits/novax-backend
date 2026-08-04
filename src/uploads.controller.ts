import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { CurrentUser } from "./current-user.decorator";
import { UploadsService } from "./uploads.service";
import { PresignUploadDto } from "./presign-upload.dto";

@ApiTags("uploads")
@ApiBearerAuth()
@Controller("api/v1/uploads")
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Post("presign")
  @ApiOperation({ summary: "Get a short-lived URL to upload a file directly to R2" })
  // Presigning is cheap but not free (an R2 auth call) — a modest limit stops
  // a buggy client from hammering this in a retry loop.
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  presign(@CurrentUser() user: { userId: string }, @Body() dto: PresignUploadDto) {
    return this.uploadsService.createPresignedUpload(user.userId, dto.purpose, dto.contentType, dto.fileName);
  }
}
