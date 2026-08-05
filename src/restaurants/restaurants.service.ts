import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateRestaurantDto } from "./dto/create-restaurant.dto";
import { UpdateRestaurantDto } from "./dto/update-restaurant.dto";
import { UpsertMenuItemDto } from "./dto/upsert-menu-item.dto";

@Injectable()
export class RestaurantsService {
  constructor(private prisma: PrismaService) {}

  // One storefront per RESTAURANT-role user, enforced by the unique ownerId
  // column — a second POST from the same owner just fails loudly instead of
  // silently creating a duplicate they'd have to manage.
  async createRestaurant(ownerId: string, dto: CreateRestaurantDto) {
    const existing = await this.prisma.restaurant.findUnique({ where: { ownerId } });
    if (existing) throw new BadRequestException("You already have a restaurant registered");
    return this.prisma.restaurant.create({ data: { ownerId, ...dto } });
  }

  async getMyRestaurant(ownerId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { ownerId },
      include: { menuItems: { orderBy: { category: "asc" } } },
    });
    if (!restaurant) throw new NotFoundException("No restaurant registered for this account yet");
    return restaurant;
  }

  async updateMyRestaurant(ownerId: string, dto: UpdateRestaurantDto) {
    await this.getMyRestaurant(ownerId);
    return this.prisma.restaurant.update({ where: { ownerId }, data: dto });
  }

  async toggleOpen(ownerId: string) {
    const restaurant = await this.getMyRestaurant(ownerId);
    // Only an admin-approved restaurant can open for orders — matches the
    // driver-side rule that KYC must be APPROVED before going online.
    if (restaurant.status === "PENDING") {
      throw new ForbiddenException("Your restaurant is awaiting admin approval");
    }
    if (restaurant.status === "SUSPENDED") {
      throw new ForbiddenException("This restaurant is suspended — contact support");
    }
    return this.prisma.restaurant.update({ where: { ownerId }, data: { isOpen: !restaurant.isOpen } });
  }

  async addMenuItem(ownerId: string, dto: UpsertMenuItemDto) {
    const restaurant = await this.getMyRestaurant(ownerId);
    return this.prisma.menuItem.create({ data: { restaurantId: restaurant.id, ...dto } });
  }

  async updateMenuItem(ownerId: string, itemId: string, dto: UpsertMenuItemDto) {
    const item = await this.getOwnedMenuItemOr404(ownerId, itemId);
    return this.prisma.menuItem.update({ where: { id: item.id }, data: dto });
  }

  // No hard delete: FoodOrderItem rows keep a required FK back to the menu
  // item they were ordered from (with a name/price snapshot alongside it),
  // so deleting the row would break historical order lookups. Taking an
  // item off the menu is a visibility toggle, not data deletion.
  async archiveMenuItem(ownerId: string, itemId: string) {
    const item = await this.getOwnedMenuItemOr404(ownerId, itemId);
    return this.prisma.menuItem.update({ where: { id: item.id }, data: { isAvailable: false } });
  }

  private async getOwnedMenuItemOr404(ownerId: string, itemId: string) {
    const item = await this.prisma.menuItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException("Menu item not found");
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: item.restaurantId } });
    if (!restaurant || restaurant.ownerId !== ownerId) throw new ForbiddenException("Not your menu item");
    return item;
  }

  // Public marketplace browse — only surfaces restaurants a customer could
  // actually order from right now.
  async browse(search?: string) {
    return this.prisma.restaurant.findMany({
      where: {
        status: "APPROVED",
        isOpen: true,
        ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
      },
      orderBy: { rating: "desc" },
    });
  }

  async getPublicDetail(id: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id },
      include: { menuItems: { where: { isAvailable: true }, orderBy: { category: "asc" } } },
    });
    if (!restaurant) throw new NotFoundException("Restaurant not found");
    return restaurant;
  }

  async listPending() {
    return this.prisma.restaurant.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" } });
  }

  async approve(id: string) {
    return this.prisma.restaurant.update({ where: { id }, data: { status: "APPROVED" } });
  }

  async suspend(id: string) {
    return this.prisma.restaurant.update({ where: { id }, data: { status: "SUSPENDED", isOpen: false } });
  }
}
