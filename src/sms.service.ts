import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// Swap the "console" branch for a real Twilio/local-aggregator call when you're
// ready to send real texts. Nothing else in the auth flow needs to change —
// this is the only place that knows how OTPs actually get delivered.
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private config: ConfigService) {}

  async sendOtp(phone: string, code: string): Promise<void> {
    const provider = this.config.get<string>("SMS_PROVIDER", "console");

    if (provider === "console") {
      this.logger.warn(`[DEV MODE] OTP for ${phone}: ${code} (no real SMS sent)`);
      return;
    }

    // TODO Phase 2: real Twilio (or local telco aggregator) integration.
    // const client = twilio(accountSid, authToken);
    // await client.messages.create({ to: phone, from: fromNumber, body: `Your Nova X code is ${code}` });
    throw new Error(`SMS_PROVIDER "${provider}" not implemented yet — see TODO in sms.service.ts`);
  }
}
