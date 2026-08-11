import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

async function main() {
  const s3 = new S3Client({
    region: "auto",
    endpoint: "https://dummy-account-id.r2.cloudflarestorage.com", forcePathStyle: true,
    credentials: { accessKeyId: "dummy-key", secretAccessKey: "dummy-secret" },
  });
  const command = new PutObjectCommand({
    Bucket: "novago-uploads",
    Key: "kyc-doc/test-user/abc-123.jpg",
    ContentType: "image/jpeg",
  });
  const url = await getSignedUrl(s3, command, { expiresIn: 300 });
  console.log("PRESIGN_OK:", url.startsWith("https://dummy-account-id.r2.cloudflarestorage.com/novago-uploads/kyc-doc/test-user/abc-123.jpg"));
  console.log(url);
}
main().catch((e) => { console.error("PRESIGN_FAILED:", e); process.exit(1); });
