import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ErrandsService } from "./errands.service";
import { CreateErrandDto } from "./dto/create-errand.dto";
import { ReportSpendDto } from "./dto/report-spend.dto";

type ReqUser = { userId: string; role: string };

@ApiTags("errands")
@ApiBearerAuth()
@Controller("api/v1/errands")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ErrandsController {
  constructor(private errandsService: ErrandsService) {}

  @Post()
  @Roles("RIDER")
  create(@CurrentUser() user: ReqUser, @Body() dto: CreateErrandDto) {
    return this.errandsService.createErrand(user.userId, dto);
  }

  @Post(":id/accept")
  @Roles("DRIVER")
  accept(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.errandsService.acceptOffer(user.userId, id);
  }

  @Post(":id/decline")
  @Roles("DRIVER")
  decline(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.errandsService.declineOffer(user.userId, id);
  }

  @Post(":id/start-shopping")
  @Roles("DRIVER")
  startShopping(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.errandsService.startShopping(user.userId, id);
  }

  @Post(":id/on-the-way")
  @Roles("DRIVER")
  onTheWay(@CurrentUser() user: ReqUser, @Param("id") id: string, @Body() dto: ReportSpendDto) {
    return this.errandsService.markOnTheWay(user.userId, id, dto.actualSpend);
  }

  @Post(":id/delivered")
  @Roles("DRIVER")
  delivered(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.errandsService.markDelivered(user.userId, id);
  }

  @Post(":id/cancel")
  cancel(@CurrentUser() user: ReqUser, @Param("id") id: string) {
    return this.errandsService.cancelErrand(id, user.userId);
  }

  @Get(":id")
  getOne(@Param("id") id: string) {
    return this.errandsService.getErrand(id);
  }

  @Get()
  listMine(@CurrentUser() user: ReqUser) {
    return this.errandsService.listMine(user.userId);
  }
}
