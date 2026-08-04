import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { RolesGuard } from "./roles.guard";
import { Roles } from "./roles.decorator";
import { AdminService } from "./admin.service";

// Every route here requires ADMIN — driver KYC approval itself stays on
// POST /users/:id/approve-kyc (already built, already @Roles("ADMIN")); this
// controller is the read side the ops dashboard needed and didn't have:
// list endpoints instead of "approve one id you already know."
@ApiTags("admin")
@ApiBearerAuth()
@Controller("api/v1/admin")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
export class AdminController {
  constructor(private adminService: AdminService) {}

  @Get("stats")
  getStats() {
    return this.adminService.getStats();
  }

  @Get("drivers/pending")
  getPendingDrivers() {
    return this.adminService.listPendingDrivers();
  }

  @Get("users")
  getUsers() {
    return this.adminService.listUsers();
  }
}
