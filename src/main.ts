// FIRST IMPORT, DELIBERATELY. Sentry instruments HTTP, Prisma and Redis by
// patching those modules as they load — if Nest pulls them in first there is
// nothing left to patch, and errors arrive stripped of request context.
import "./instrument";
import "reflect-metadata";
import helmet from "helmet";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { assertProductionConfig } from "./config.validation";
import { sentryEnabled } from "./instrument";

async function bootstrap() {
  // Fail fast BEFORE the app boots: a production deploy missing JWT secrets
  // (or still logging OTPs to the console instead of texting them) should
  // refuse to start rather than run insecurely and look healthy.
  assertProductionConfig();

  const app = await NestFactory.create(AppModule);

  // Routes unhandled exceptions from Nest's own filters into Sentry. No-op
  // when SENTRY_DSN is unset.
  if (sentryEnabled) {
    const { SentryGlobalFilter } = await import("@sentry/nestjs/setup");
    const { HttpAdapterHost } = await import("@nestjs/core");
    app.useGlobalFilters(new SentryGlobalFilter(app.get(HttpAdapterHost).httpAdapter));
    console.log("Sentry error reporting: on");
  }

  const docsEnabled = process.env.NODE_ENV !== "production" || process.env.ENABLE_DOCS === "true";

  // Security headers. The API answered with none of these and advertised
  // `x-powered-by: Express` on every response, which is free reconnaissance.
  //
  // CSP is left OFF when the docs are on, because Swagger UI runs inline
  // scripts and styles that a default policy blocks — an API that returns
  // JSON gets very little from a CSP anyway, while the docs page is the one
  // thing here that actually renders HTML.
  app.use(
    helmet({
      contentSecurityPolicy: docsEnabled ? false : undefined,
      // The apps are served from GitHub Pages / the Capacitor webview, i.e. a
      // different origin to this API. Same-origin CORP would block them; CORS
      // above is what actually governs who may call this.
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.getHttpAdapter().getInstance().disable("x-powered-by");

  // Reject any request body field that isn't declared on the DTO,
  // and strip/whitelist the rest — first line of defense against bad input.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS_ORIGINS is a comma-separated allowlist (e.g.
  // "https://amdapex55-commits.github.io,https://novago.pk"). Unset =>
  // wide-open, which is fine for local dev but is exactly how a hostile page
  // in someone's browser gets to call this API with their session, so
  // production is required to set it (see config.validation.ts).
  const corsOrigins = process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
  app.enableCors(corsOrigins?.length ? { origin: corsOrigins, credentials: true } : {});

  // Swagger exposes every route, DTO shape and auth requirement — useful in
  // dev, free reconnaissance in production. Opt back in with ENABLE_DOCS=true
  // if you specifically want it on a deployed environment.
  if (docsEnabled) {
    const config = new DocumentBuilder()
      .setTitle("Nova Go Logistics API")
      .setDescription("Auth, users, trips, location, delivery — single monolith")
      .setVersion("0.1")
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api/docs", app, document);
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Nova Go backend running on port ${port}`);
  if (docsEnabled) console.log(`API docs at /api/docs`);
}
bootstrap();
