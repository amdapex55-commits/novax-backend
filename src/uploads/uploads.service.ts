import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { UploadPurpose } from "./dto/presign-upload.dto";

const PRESIGN_TTL_SECONDS = 300; // 5 minutes to actually perform the PUT

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private s3: S3Client;
  private bucket: string;
  private publicUrlBase: string;
  private isConfigured: boolean;

  constructor(private config: ConfigService) {
    const accountId = this.config.get<string>("R2_ACCOUNT_ID", "");
    const accessKeyId = this.config.get<string>("R2_ACCESS_KEY_ID", "");
    const secretAccessKey = this.config.get<string>("R2_SECRET_ACCESS_KEY", "");
    this.bucket = this.config.get<string>("R2_BUCKET_NAME", "novago-uploads");
    // Normalised, and checked loudly enough that a typo cannot hide.
    //
    // A mistyped base is the nastiest variety of misconfiguration here,
    // because everything else keeps working: presigning succeeds, the PUT
    // succeeds, the file really is in the bucket — only the URL written into
    // the database points nowhere. Nobody notices until a dispatcher opens an
    // approval weeks later and sees a broken image where a licence should be,
    // by which point the wrong URL is on every document uploaded since.
    //
    // Seen in production: "…r2.de" instead of "…r2.dev".
    const rawBase = this.config.get<string>("R2_PUBLIC_URL_BASE", "").trim();
    this.publicUrlBase = rawBase.replace(/\/+$/, "");
    if (rawBase) {
      const looksWrong =
        !/^https?:\/\//i.test(this.publicUrlBase) ||
        /\.r2\.de$/i.test(this.publicUrlBase);
      if (looksWrong) {
        this.logger.error(
          `R2_PUBLIC_URL_BASE looks wrong: "${this.publicUrlBase}". ` +
            "Uploads will still succeed, but every stored document URL will be unreachable. " +
            "Expected something like https://pub-<hash>.r2.dev (note the trailing 'v').",
        );
      }
    }

    // Presigning is pure local crypto (SigV4) — it never contacts R2, so a
    // missing accountId doesn't fail here. It silently falls through to the
    // AWS SDK's default endpoint construction and hands back a confidently
    // wrong, fully-signed URL pointing at a plain amazonaws.com domain.
    // Confirmed by actually generating one with an empty accountId: no
    // exception, just a URL that would fail hours later when a driver's app
    // tries to actually upload a KYC photo to it. Fail loud here instead, at
    // the moment of misconfiguration, not at the moment furthest from it.
    this.isConfigured = Boolean(accountId && accessKeyId && secretAccessKey);

    // R2 speaks the S3 API, so the regular AWS SDK works against it — just
    // point endpoint at R2's account-scoped URL instead of AWS. region is
    // required by the SDK's types but meaningless to R2; "auto" is R2's own
    // documented placeholder value for it.
    this.s3 = new S3Client({
      region: "auto",
      endpoint: accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined,
      credentials: { accessKeyId, secretAccessKey },
      // Required for R2: the AWS SDK defaults to virtual-hosted-style URLs
      // (bucket.account.r2.cloudflarestorage.com), but R2 only supports
      // path-style (account.r2.cloudflarestorage.com/bucket) — confirmed by
      // actually generating a presigned URL against a dummy R2 endpoint and
      // checking the SDK's default output before adding this flag.
      forcePathStyle: true,
    });
  }

  /** Returns a short-lived URL the client PUTs the file to directly — the file
   * never passes through our backend, so we're not paying to proxy bytes. */
  async createPresignedUpload(userId: string, purpose: UploadPurpose, contentType: string, fileName: string) {
    if (!this.isConfigured) {
      throw new InternalServerErrorException(
        "R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY in .env",
      );
    }

    const extension = fileName.includes(".") ? fileName.split(".").pop() : "bin";
    // Namespaced by purpose then user, so an admin browsing the bucket (or a
    // future cleanup job) can reason about what's in it without reading DB rows.
    const key = `${purpose}/${userId}/${randomUUID()}.${extension}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: PRESIGN_TTL_SECONDS });

    // The object's eventual public URL — save this on the User/Trip/Delivery
    // row once the client confirms the PUT succeeded. R2 buckets need a public
    // access domain or custom domain configured for this to actually resolve;
    // until then this is still useful as the canonical key to store.
    const publicUrl = this.publicUrlBase ? `${this.publicUrlBase}/${key}` : key;

    return { uploadUrl, publicUrl, key, expiresInSeconds: PRESIGN_TTL_SECONDS };
  }
}
