import { Body, Controller, ForbiddenException, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { UploadsService } from "./uploads.service";
import { PrismaService } from "../prisma/prisma.service";
import { PresignUploadDto } from "./dto/presign-upload.dto";
import { ViewDocumentDto } from "./dto/view-document.dto";

@ApiTags("uploads")
@ApiBearerAuth()
@Controller("api/v1/uploads")
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(
    private uploadsService: UploadsService,
    private prisma: PrismaService,
  ) {}

  @Post("presign")
  @ApiOperation({ summary: "Get a short-lived URL to upload a file directly to R2" })
  // Presigning is cheap but not free (an R2 auth call) — a modest limit stops
  // a buggy client from hammering this in a retry loop.
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  presign(@CurrentUser() user: { userId: string }, @Body() dto: PresignUploadDto) {
    return this.uploadsService.createPresignedUpload(user.userId, dto.purpose, dto.contentType, dto.fileName);
  }

  /**
   * Open a private document — a CNIC, a licence, a proof of delivery.
   *
   * These used to be served straight from a public R2 origin, so the only
   * thing standing between someone's identity document and the internet was
   * the difficulty of guessing a UUID. Now the object is private and this is
   * the only way in: prove who you are, prove you are allowed, and get a URL
   * that stops working two minutes later.
   *
   * Two callers are allowed, and no others:
   *   - an ADMIN, who reviews these for a living
   *   - the driver the document belongs to, checking what they submitted
   *
   * Ownership is decided by the object key, which embeds the uploader's user
   * id as its second segment (`kyc-doc/<userId>/<uuid>.jpg`) — the same value
   * the presign step wrote, so it cannot be argued with by the caller.
   */
  /**
   * Open a private document — a CNIC, a licence, a proof of delivery.
   *
   * These used to be served straight from a public R2 origin, so the only
   * thing between someone's identity document and the internet was the
   * difficulty of guessing a UUID. The object is private now and this is the
   * only way in: prove who you are, prove you are allowed, and get a URL that
   * stops working two minutes later.
   *
   * Two callers are allowed and no others:
   *   - an ADMIN, who reviews these for a living
   *   - the driver the document belongs to, checking what they submitted
   *
   * Ownership is decided by the object key, which embeds the uploader's user
   * id as its second segment (`kyc-doc/<userId>/<uuid>.jpg`) — written by the
   * presign step, so the caller cannot argue with it.
   *
   * POST with the key in the body rather than in the path: object keys
   * contain slashes, and a document reference has no business appearing in an
   * access log, a proxy cache or browser history.
   */
  @Post("view")
  @ApiOperation({ summary: "Short-lived signed URL for a private document (admin, or its owner)" })
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async view(
    @CurrentUser() user: { userId: string; role: string },
    @Body() dto: ViewDocumentDto,
  ) {
    if (user.role !== "ADMIN") {
      const segments = dto.key.replace(/^https?:\/\/[^/]+\//i, "").split("/");
      if (segments[1] !== user.userId) {
        throw new ForbiddenException("That document isn't yours.");
      }
    }
    const url = await this.uploadsService.signedViewUrl(dto.key);
    return { url, expiresInSeconds: 120 };
  }
}
