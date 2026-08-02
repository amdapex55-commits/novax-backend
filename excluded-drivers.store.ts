import { Injectable } from "@nestjs/common";
import { RedisService } from "./redis.service";

// Replaces the in-memory Map<string, Set<string>> that used to live inside
// TripsService/DeliveryService — that worked for one process but silently
// lost all in-flight matching state on every restart, and would give wrong
// answers the moment there's a second backend instance (each process would
// have its own map, so a driver excluded on instance A could still be
// re-offered the same trip by instance B). Redis makes this shared and
// durable across restarts for the price of one extra network hop per check.
const EXCLUDED_TTL_SECONDS = 60 * 60; // generous upper bound for one matching attempt to resolve

type MatchScope = "trip" | "delivery" | "foodOrder" | "errand";

@Injectable()
export class ExcludedDriversStore {
  constructor(private redis: RedisService) {}

  private key(scope: MatchScope, id: string): string {
    return `match:excluded:${scope}:${id}`;
  }

  async add(scope: MatchScope, id: string, driverId: string): Promise<void> {
    const key = this.key(scope, id);
    await this.redis.client.sadd(key, driverId);
    // Refresh the TTL on every add, not just at creation — a trip that's
    // still actively cascading through candidates shouldn't have its
    // exclusion set expire out from under it mid-match.
    await this.redis.client.expire(key, EXCLUDED_TTL_SECONDS);
  }

  async getAll(scope: MatchScope, id: string): Promise<Set<string>> {
    const members = await this.redis.client.smembers(this.key(scope, id));
    return new Set(members);
  }

  async clear(scope: MatchScope, id: string): Promise<void> {
    await this.redis.client.del(this.key(scope, id));
  }
}
