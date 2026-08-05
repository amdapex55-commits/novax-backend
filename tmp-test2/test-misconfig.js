"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
async function main() {
    // Simulating R2_ACCOUNT_ID being unset (empty string, falsy) — exactly what
    // happens if someone forgets to fill in .env before running this.
    const accountId = "";
    const s3 = new client_s3_1.S3Client({
        region: "auto",
        endpoint: accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined,
        credentials: { accessKeyId: "", secretAccessKey: "" },
        forcePathStyle: true,
    });
    const command = new client_s3_1.PutObjectCommand({ Bucket: "novax-uploads", Key: "kyc-doc/u1/x.jpg", ContentType: "image/jpeg" });
    const url = await (0, s3_request_presigner_1.getSignedUrl)(s3, command, { expiresIn: 300 });
    console.log("NO ERROR THROWN. Generated URL:", url);
}
main().catch((e) => console.error("THREW:", e.message));
