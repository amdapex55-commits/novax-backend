import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  public client: Redis;

  constructor(private config: ConfigService) {
    this.client = new Redis(this.config.get<string>("REDIS_URL", "redis://localhost:6379"));
  }

  async onModuleInit() {
    // ioredis connects lazily on first command by default; this just surfaces
    // connection errors at boot instead of on the first request.
    await this.client.ping();
  }

  async onModuleDestroy() {
    this.client.disconnect();
  }
}
