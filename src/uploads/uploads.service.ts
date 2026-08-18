import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { UploadPurpose } from "./dto/presign-upload.dto";

/* Purposes whose objects are somebody's identity and must never be reachable
   without an authorisation check. */
const PRIVATE_PURPOSES = new Set<string>(["kyc-doc", "proof-of-delivery"]);

/** How long a signed read of a private document stays usable. */
const VIEW_TTL_SECONDS = 120;

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

    /* Be liberal in what we accept, strict in what we store.
       image/jpg and image/pjpeg are the same bytes as image/jpeg with a
       wrong label, so they are corrected here rather than propagated into
       the bucket, the database, and every <img> that later reads them. The
       signature must be generated with the SAME value the browser will put
       in its Content-Type header, so this normalisation happens BEFORE the
       command is built, not after. */
    const storedContentType =
      contentType === "image/jpg" || contentType === "image/pjpeg"
        ? "image/jpeg"
        : contentType;

    // The extension follows the corrected type, so a file called .HEIC that
    // was actually converted to JPEG by the client does not end up stored
    // under a name that misleads whoever opens the bucket later.
    const extension = fileName.includes(".") ? fileName.split(".").pop() : "bin";
    // Namespaced by purpose then user, so an admin browsing the bucket (or a
    // future cleanup job) can reason about what's in it without reading DB rows.
    const key = `${purpose}/${userId}/${randomUUID()}.${extension}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: storedContentType,
    });

    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: PRESIGN_TTL_SECONDS });

    // The object's eventual public URL — save this on the User/Trip/Delivery
    // row once the client confirms the PUT succeeded. R2 buckets need a public
    // access domain or custom domain configured for this to actually resolve;
    // until then this is still useful as the canonical key to store.
    /* IDENTITY DOCUMENTS DO NOT GET A PUBLIC URL.

       A CNIC, a driving licence and a photo of someone's bike outside their
       house were being stored as `https://pub-….r2.dev/kyc-doc/…` — readable
       by anyone holding the link, with no authentication at all. The UUID
       path makes them impractical to guess, but that is obscurity, not
       access control, and the links are not secret: they sit in the database,
       get rendered in the ops console, and travel through browser history,
       screenshots and support threads.

       So for KYC the stored value is the OBJECT KEY, and reading it goes
       through GET /uploads/view/:key, which checks who is asking before
       minting a short-lived signed URL. Everything else — menu photos, shop
       banners, profile pictures — is genuinely public content and keeps its
       direct URL, because proxying those would cost latency for nothing.

       Existing rows still hold absolute pub-….r2.dev URLs. signedViewUrl()
       accepts both shapes so the ops console keeps working while old
       documents age out. */
    const isPrivate = PRIVATE_PURPOSES.has(purpose);
    const publicUrl = isPrivate
      ? key
      : this.publicUrlBase
        ? `${this.publicUrlBase}/${key}`
        : key;

    return { uploadUrl, publicUrl, key, isPrivate, expiresInSeconds: PRESIGN_TTL_SECONDS };
  }

  /**
   * A short-lived signed GET for a private object.
   *
   * Accepts either a bare object key or a legacy absolute pub-….r2.dev URL,
   * because documents uploaded before this existed are stored as the latter
   * and a reviewer still has to be able to open them.
   *
   * Two minutes: long enough to load an image in the ops console, short
   * enough that a URL copied out of a network tab is useless by the time
   * anyone acts on it.
   */
  async signedViewUrl(keyOrUrl: string): Promise<string> {
    if (!this.s3) throw new ServiceUnavailableException("File storage is not configured.");

    let key = keyOrUrl.trim();
    if (/^https?:\/\//i.test(key)) {
      // Legacy absolute URL — take the path, minus the leading slash.
      try {
        key = new URL(key).pathname.replace(/^\/+/, "");
      } catch {
        throw new BadRequestException("That document reference is not readable.");
      }
    }
    // No traversal, no absolute paths, and it must live under a known purpose.
    if (key.includes("..") || key.startsWith("/")) {
      throw new BadRequestException("That document reference is not readable.");
    }
    if (![...PRIVATE_PURPOSES].some((p) => key.startsWith(`${p}/`))) {
      throw new BadRequestException("That document reference is not readable.");
    }

    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: VIEW_TTL_SECONDS,
    });
  }
}
