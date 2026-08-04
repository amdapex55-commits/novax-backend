import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { LocationGateway } from "./location.gateway";

const CONTEXT_TYPES = ["TRIP", "DELIVERY", "FOOD_ORDER", "ERRAND"] as const;
type ContextType = (typeof CONTEXT_TYPES)[number];

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private locationGateway: LocationGateway,
  ) {}

  private assertValidContextType(contextType: string): asserts contextType is ContextType {
    if (!CONTEXT_TYPES.includes(contextType as ContextType)) {
      throw new BadRequestException(`contextType must be one of ${CONTEXT_TYPES.join(", ")}`);
    }
  }

  // The two people allowed in a thread are exactly whoever's tied together
  // by the underlying job record — never stored redundantly on ChatMessage,
  // so a reassigned driver or a job that never got a driver is always read
  // fresh from the one place it's tracked.
  private async resolveParticipants(contextType: ContextType, contextId: string): Promise<{ a: string; b: string | null }> {
    switch (contextType) {
      case "TRIP": {
        const trip = await this.prisma.trip.findUnique({ where: { id: contextId }, select: { riderId: true, driverId: true } });
        if (!trip) throw new NotFoundException("Trip not found");
        return { a: trip.riderId, b: trip.driverId };
      }
      case "DELIVERY": {
        const delivery = await this.prisma.delivery.findUnique({ where: { id: contextId }, select: { senderId: true, driverId: true } });
        if (!delivery) throw new NotFoundException("Delivery not found");
        return { a: delivery.senderId, b: delivery.driverId };
      }
      case "FOOD_ORDER": {
        const order = await this.prisma.foodOrder.findUnique({ where: { id: contextId }, select: { customerId: true, driverId: true } });
        if (!order) throw new NotFoundException("Order not found");
        return { a: order.customerId, b: order.driverId };
      }
      case "ERRAND": {
        const errand = await this.prisma.errand.findUnique({ where: { id: contextId }, select: { requesterId: true, driverId: true } });
        if (!errand) throw new NotFoundException("Errand not found");
        return { a: errand.requesterId, b: errand.driverId };
      }
    }
  }

  async listMessages(contextType: string, contextId: string, userId: string) {
    this.assertValidContextType(contextType);
    const { a, b } = await this.resolveParticipants(contextType, contextId);
    if (userId !== a && userId !== b) throw new ForbiddenException("Not part of this conversation");

    return this.prisma.chatMessage.findMany({
      where: { contextType, contextId },
      orderBy: { createdAt: "asc" },
      select: { id: true, senderId: true, body: true, createdAt: true },
    });
  }

  async sendMessage(contextType: string, contextId: string, senderId: string, body: string) {
    this.assertValidContextType(contextType);
    const { a, b } = await this.resolveParticipants(contextType, contextId);
    if (senderId !== a && senderId !== b) throw new ForbiddenException("Not part of this conversation");
    // No second participant yet (e.g. a trip still waiting to be matched) —
    // nobody to send to, and nothing meaningful to persist.
    if (!a || !b) throw new BadRequestException("This conversation doesn't have both participants yet");

    const message = await this.prisma.chatMessage.create({
      data: { contextType, contextId, senderId, body },
      select: { id: true, senderId: true, body: true, createdAt: true },
    });

    const recipientId = senderId === a ? b : a;
    this.locationGateway.emitToUser(recipientId, "chat:message", { contextType, contextId, message });

    return message;
  }
}
