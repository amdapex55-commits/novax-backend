import { SetMetadata } from "@nestjs/common";

export const SENSITIVE_ACTION = "sensitiveAction";

/**
 * Mark a route as one that moves money or changes who can get in.
 *
 * Ordinary requests fail OPEN when Redis is unreachable, because failing
 * closed would sign out every driver on the platform the moment Redis
 * blinked. Routes marked here fail CLOSED instead: if we cannot tell whether
 * this session has been revoked, we refuse.
 *
 * The split matters because those are the exact operations ops was trying to
 * stop when they suspended an account. A suspended driver reading their
 * earnings during an outage is tolerable; the same driver withdrawing money
 * is not.
 *
 * A decorator rather than a call inside each handler, so a new withdrawal or
 * admin route cannot quietly ship without the check — the same reason the
 * credit limit and fleet segregation live in one function instead of four.
 */
export const SensitiveAction = (action: string) => SetMetadata(SENSITIVE_ACTION, action);
