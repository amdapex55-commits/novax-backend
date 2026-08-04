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
      'SMS_PROVIDER is "console" — OTP codes would be written to server logs instead of texted. Configure a real SMS provider.',
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
