// Boot-time config guard. Runs before NestFactory.create() in main.ts.
//
// The failure mode this prevents: a production deploy that's missing
// JWT_ACCESS_SECRET starts fine, signs tokens with `undefined`, and looks
// completely healthy — until someone notices every token is forgeable.
// Same for SMS_PROVIDER=console, where OTP codes get written to the server
// log instead of texted, so anyone with log access can log in as anyone.
//
// Non-production keeps working with no env file at all, so local dev and
// this repo's docker-compose setup are unaffected.

const REQUIRED_IN_PRODUCTION = [
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
];

const MIN_SECRET_LENGTH = 32;

export function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;

  const problems: string[] = [];

  for (const key of REQUIRED_IN_PRODUCTION) {
    if (!process.env[key]) problems.push(`${key} is not set`);
  }

  for (const key of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"]) {
    const value = process.env[key];
    if (value && value.length < MIN_SECRET_LENGTH) {
      problems.push(`${key} is shorter than ${MIN_SECRET_LENGTH} chars — generate a real random secret`);
    }
  }

  if (process.env.JWT_ACCESS_SECRET && process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
    problems.push("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values");
  }

  const smsProvider = process.env.SMS_PROVIDER ?? "console";
  if (smsProvider === "console") {
    problems.push(
      'SMS_PROVIDER is "console" — OTP codes would be written to server logs instead of texted. Set SMS_PROVIDER=twilio.',
    );
  } else if (smsProvider === "twilio") {
    // Catch a half-configured Twilio at BOOT rather than at the moment a
    // real customer taps "send code" and gets a 500. The whole point of
    // this file is that misconfiguration fails loudly and early.
    const missing = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]
      .filter((k) => !process.env[k]);
    if (missing.length) {
      problems.push(`SMS_PROVIDER is "twilio" but ${missing.join(", ")} not set — OTP delivery would fail.`);
    }
  } else {
    problems.push(`SMS_PROVIDER "${smsProvider}" is not implemented. Use "twilio".`);
  }

  // R2 credentials. The AWS SDK does NOT throw on an empty accountId — it
  // silently builds a request against a nonsense endpoint, so a misconfigured
  // deploy looks perfectly healthy until the first driver tries to upload
  // their CNIC and gets an error nobody can explain. Fail at boot instead.
  const r2Keys = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"];
  const r2Set = r2Keys.filter((k) => process.env[k]);
  if (r2Set.length > 0 && r2Set.length < r2Keys.length) {
    problems.push(
      `R2 storage is partially configured — missing ${r2Keys.filter((k) => !process.env[k]).join(", ")}. ` +
        "KYC and proof-of-delivery uploads would fail at the moment a driver needs them.",
    );
  } else if (r2Set.length === 0) {
    problems.push(
      "No R2 storage configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME). " +
        "Driver KYC document upload is part of onboarding — it cannot work without this.",
    );
  }

  if (!process.env.CORS_ORIGINS) {
    problems.push(
      "CORS_ORIGINS is not set — the API would accept browser requests from any origin. Set a comma-separated allowlist.",
    );
  }

  if (problems.length > 0) {
    throw new Error(
      "Refusing to start in production with an unsafe configuration:\n" +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}
