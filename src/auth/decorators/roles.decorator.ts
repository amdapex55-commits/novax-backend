import { SetMetadata } from "@nestjs/common";

export const ROLES_KEY = "roles";
// Usage: @Roles("ADMIN") or @Roles("DRIVER", "ADMIN")
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
