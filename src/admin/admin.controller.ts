import { Body, Controller, Get, Param, Post, Query, UseGuards, Patch } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { ManualAssignDto } from "./dto/manual-assign.dto";
import { SuspendUserDto } from "./dto/suspend-user.dto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
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

  // --- Live supply ---

  @Get("growth")
  @ApiOperation({ summary: "Business leads, top referrers and loyalty totals" })
  getGrowth() {
    return this.adminService.getGrowth();
  }

  @Patch("leads/:id")
  @ApiOperation({ summary: "Mark a business lead contacted or closed" })
  setLeadStatus(@Param("id") id: string, @Body() body: { status: "NEW" | "CONTACTED" | "CLOSED" }) {
    return this.adminService.setLeadStatus(id, body.status);
  }

  @Get("drivers/balances")
  @ApiOperation({ summary: "Driver wallet balances — who owes, who's blocked, most indebted first" })
  getDriverBalances() {
    return this.adminService.listDriverBalances();
  }

  @Get("drivers/live")
  @ApiOperation({ summary: "Drivers online now, with what each is currently doing" })
  getLiveDrivers() {
    return this.adminService.listLiveDrivers();
  }

  // --- Moderation ---

  @Post("users/:id/suspend")
  @ApiOperation({ summary: "Suspend an account (forces drivers offline immediately)" })
  suspend(@Param("id") id: string, @Body() dto: SuspendUserDto) {
    return this.adminService.setUserActive(id, false, dto.reason);
  }

  @Post("users/:id/reactivate")
  @ApiOperation({ summary: "Reactivate a suspended account" })
  reactivate(@Param("id") id: string) {
    return this.adminService.setUserActive(id, true);
  }

  // --- Health signals ---

  @Get("cancellations")
  @ApiOperation({ summary: "Recent cancellations across rides, food and parcels" })
  getCancellations(@Query("hours") hours?: string) {
    const parsed = Number(hours);
    return this.adminService.listCancellations(Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 720) : 24);
  }

  @Get("balances")
  @ApiOperation({ summary: "Non-zero wallet balances — the settlement worklist" })
  getBalances() {
    return this.adminService.listBalances();
  }

  // --- Support ---

  @Get("tickets")
  @ApiOperation({ summary: "Support tickets (optionally filter by status)" })
  getTickets(@Query("status") status?: string) {
    return this.adminService.listTickets(status);
  }

  @Post("tickets/:id/resolve")
  resolveTicket(@Param("id") id: string) {
    return this.adminService.resolveTicket(id);
  }
}
