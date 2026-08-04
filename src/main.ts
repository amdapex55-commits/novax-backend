import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { assertProductionConfig } from "./config.validation";

async function bootstrap() {
  // Fail fast BEFORE the app boots: a production deploy missing JWT secrets
  // (or still logging OTPs to the console instead of texting them) should
  // refuse to start rather than run insecurely and look healthy.
  assertProductionConfig();

  const app = await NestFactory.create(AppModule);

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
  // "https://amdapex55-commits.github.io,https://novax.pk"). Unset =>
  // wide-open, which is fine for local dev but is exactly how a hostile page
  // in someone's browser gets to call this API with their session, so
  // production is required to set it (see config.validation.ts).
  const corsOrigins = process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
  app.enableCors(corsOrigins?.length ? { origin: corsOrigins, credentials: true } : {});

  // Swagger exposes every route, DTO shape and auth requirement — useful in
  // dev, free reconnaissance in production. Opt back in with ENABLE_DOCS=true
  // if you specifically want it on a deployed environment.
  const docsEnabled = process.env.NODE_ENV !== "production" || process.env.ENABLE_DOCS === "true";
  if (docsEnabled) {
    const config = new DocumentBuilder()
      .setTitle("Nova X Logistics API")
      .setDescription("Auth, users, trips, location, delivery — single monolith")
      .setVersion("0.1")
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api/docs", app, document);
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Nova X backend running on port ${port}`);
  if (docsEnabled) console.log(`API docs at /api/docs`);
}
bootstrap();
