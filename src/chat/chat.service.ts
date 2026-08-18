import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LocationGateway } from "../location/location.gateway";
import { NotificationsService } from "../notifications/notifications.service";

const CONTEXT_TYPES = ["TRIP", "DELIVERY", "FOOD_ORDER", "ERRAND"] as const;
type ContextType = (typeof CONTEXT_TYPES)[number];

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private locationGateway: LocationGateway,
    private notificationsService: NotificationsService,
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
      select: { id: true, senderId: true, body: true, createdAt: true, deliveredAt: true, readAt: true },
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
      // Stamped delivered on write: it is on our server and on its way to a
      // socket that is very likely open. Read is the one that must be earned.
      data: { contextType, contextId, senderId, body, deliveredAt: new Date() },
      select: { id: true, senderId: true, body: true, createdAt: true, deliveredAt: true, readAt: true },
    });

    const recipientId = senderId === a ? b : a;
    this.locationGateway.emitToUser(recipientId, "chat:message", { contextType, contextId, message });

    /* THE SOCKET EVENT WAS THE ONLY THING THAT FIRED.

       Only the open thread listens for chat:message, so a message sent to
       someone who is not sitting on that exact screen reached nobody — no
       badge, no buzz, no trace. A passenger asking "which gate?" watched
       their words go nowhere while the rider circled the block.

       The notification is what makes it arrive when the thread is closed,
       which is almost always. Not awaited: a slow notification must never
       delay the message itself. */
    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: { name: true },
    });
    void this.notificationsService.create(
      recipientId,
      sender?.name ? `Message from ${sender.name}` : "New message",
      body.length > 90 ? `${body.slice(0, 90)}…` : body,
    );

    return message;
  }

  /**
   * Mark everything the other person sent in this thread as read.
   *
   * Called when the thread is opened, and again on each incoming message
   * while it stays open. The sender is told over the socket so their ticks
   * turn without polling.
   */
  async markRead(contextType: string, contextId: string, readerId: string) {
    this.assertValidContextType(contextType);
    const { a, b } = await this.resolveParticipants(contextType, contextId);
    if (readerId !== a && readerId !== b) throw new ForbiddenException("Not part of this conversation");

    const now = new Date();
    const res = await this.prisma.chatMessage.updateMany({
      where: { contextType, contextId, senderId: { not: readerId }, readAt: null },
      data: { readAt: now, deliveredAt: now },
    });

    if (res.count > 0) {
      const otherId = readerId === a ? b : a;
      if (otherId) {
        this.locationGateway.emitToUser(otherId, "chat:read", { contextType, contextId, at: now.toISOString() });
      }
    }
    return { read: res.count };
  }

  /** How many messages in this thread the caller has not read. */
  async unreadCount(contextType: string, contextId: string, userId: string) {
    this.assertValidContextType(contextType);
    const count = await this.prisma.chatMessage.count({
      where: { contextType, contextId, senderId: { not: userId }, readAt: null },
    });
    return { count };
  }
}
