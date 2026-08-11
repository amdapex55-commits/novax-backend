/**
 * Sentry initialisation.
 *
 * MUST be imported before anything else in main.ts. Sentry instruments the
 * HTTP layer, Prisma and Redis by monkey-patching their modules as they load,
 * so if Nest imports them first there is nothing left to patch and errors
 * arrive with no request context attached — which is most of their value.
 *
 * Safe to leave unconfigured: with no SENTRY_DSN this is a no-op, so local dev
 * and anyone running from a fresh clone are unaffected.
 */
import * as Sentry from "@sentry/nestjs";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    // Ties an error to the deploy that caused it. Railway exposes the commit
    // SHA, so a regression can be traced to a specific push without guessing.
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,

    // 10% of transactions. Full tracing on a ride-hailing backend means a
    // span for every GPS ping, which buries the useful traces and burns the
    // quota in a day.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),

    // Don't ship PII to a third party by default. Phone numbers are the
    // primary identifier in this system and there is no reason for them to
    // leave the country to debug a stack trace.
    sendDefaultPii: false,

    beforeSend(event) {
      // Belt and braces over sendDefaultPii: strip the fields most likely to
      // carry a credential or a customer's identity if something upstream
      // starts attaching them.
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      if (event.request?.data && typeof event.request.data === "object") {
        const data = event.request.data as Record<string, unknown>;
        for (const key of ["phone", "code", "otp", "password", "token", "refreshToken", "cnicNumber"]) {
          if (key in data) data[key] = "[redacted]";
        }
      }
      return event;
    },

    ignoreErrors: [
      // A driver's phone leaving coverage mid-ping is normal in Karachi, not
      // an incident. Alerting on it trains everyone to ignore Sentry.
      "ECONNRESET",
      "EPIPE",
      "Client network socket disconnected",
    ],
  });
}

export const sentryEnabled = Boolean(dsn);
