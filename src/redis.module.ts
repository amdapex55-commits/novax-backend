import { Global, Module } from "@nestjs/common";
import { RedisService } from "./redis.service";

// @Global so location, trips, and (later) caching/rate-limiting can all share
// one Redis connection instead of each module opening its own.
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
