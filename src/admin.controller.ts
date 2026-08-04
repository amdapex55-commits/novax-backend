import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { ManualAssignDto } from "./manual-assign.dto";
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

  // --- Dispatch fallback: the "nothing is moving, do something" screen ---

  @Get("stuck-jobs")
  @ApiOperation({ summary: "Jobs that automatic matching hasn't placed — ops must intervene" })
  getStuckJobs(@Query("minutes") minutes?: string) {
    const parsed = Number(minutes);
    return this.adminService.listStuckJobs(Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 120) : 3);
  }

  @Get("drivers/available")
  @ApiOperation({ summary: "Approved drivers currently online — the call list for manual dispatch" })
  getAvailableDrivers() {
    return this.adminService.listAvailableDrivers();
  }

  @Post("assign")
  @ApiOperation({ summary: "Assign a driver to a stuck job by hand (after phoning them)" })
  assign(@Body() dto: ManualAssignDto) {
    return this.adminService.manuallyAssign(dto.jobType, dto.jobId, dto.driverId);
  }
}
