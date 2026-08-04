import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Logger, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { Namespace, Socket } from "socket.io";
import { LocationService } from "./location.service";
import { PrismaService } from "./prisma.service";

interface AuthedSocket extends Socket {
  userId?: string;
  role?: string;
}

// One gateway, namespaced /location. Drivers push GPS pings here; riders join
// a trip-specific room to receive their assigned driver's position live.
// This is the piece the roadmap flags as "split into its own service first"
// once a single city's write volume outgrows one process — until then it's
// just another module in the monolith.
@WebSocketGateway({ namespace: "/location", cors: { origin: "*" } })
export class LocationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(LocationGateway.name);

  // Typed as Namespace, not Server: @WebSocketGateway({ namespace: "/location" })
  // makes NestJS inject the namespace instance itself (server.of("/location")) —
  // Server's own .sockets field would actually BE a Namespace, requiring a second
  // .sockets to reach the socket map. Typing this as Namespace keeps the type
  // checker honest about what's really here instead of masking it with `Server`.
  @WebSocketServer()
  server: Namespace;

  constructor(
    private locationService: LocationService,
    private jwt: JwtService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  // Same JWT access token the REST API uses — pass it as `auth: { token }` on
  // the client's socket.io connect() call. Keeps one auth system, not two.
  async handleConnection(client: AuthedSocket) {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new UnauthorizedException("Missing token");
      const payload = this.jwt.verify(token, {
        secret: this.config.get<string>("JWT_ACCESS_SECRET"),
      });
      // Narrow to a definite string once, here — client.userId is a mutable
      // optional property on the socket, so TS won't carry the "just
      // assigned" narrowing through the await below (property narrowing on
      // objects doesn't survive across statements/awaits the way a local
      // const does).
      const userId: string = payload.sub;
      client.userId = userId;
      client.role = payload.role;
      this.logger.log(`Socket connected: user ${userId} (${client.role})`);

      // DriverProfile.isOnline is the durable "is this driver actually
      // available" flag food/errand matching filters on (Redis geo
      // membership alone doesn't carry the RIDE-vs-FOOD_ERRAND mode). This
      // socket connection IS a driver going online, so flip it here rather
      // than leaving the column permanently false. upsert because a brand
      // new driver account may not have a DriverProfile row yet (created
      // lazily by the Vehicle screen) — connecting shouldn't 500 on that.
      if (client.role === "DRIVER") {
        await this.prisma.driverProfile.upsert({
          where: { userId },
          create: { userId, vehicleType: "bike", isOnline: true },
          update: { isOnline: true },
        });
      }
    } catch {
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: AuthedSocket) {
    if (client.role === "DRIVER" && client.userId) {
      await this.locationService.removeDriver(client.userId);
      await this.prisma.driverProfile
        .update({ where: { userId: client.userId }, data: { isOnline: false } })
        .catch(() => {}); // profile may not exist yet — nothing to flip off
    }
  }

  @SubscribeMessage("driver:location")
  async onDriverLocation(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { lat: number; lng: number; tripId?: string },
  ) {
    if (client.role !== "DRIVER" || !client.userId) return;

    await this.locationService.updateDriverLocation(client.userId, body.lat, body.lng);

    // If this driver is actively on a trip, push the position straight to the
    // rider who's watching it — this is the "live tracking on the map" feature.
    if (body.tripId) {
      this.server.to(`trip:${body.tripId}`).emit("trip:driverLocation", {
        tripId: body.tripId,
        lat: body.lat,
        lng: body.lng,
      });
    }
  }

  // Rider's app calls this once matched, to start receiving driver:location pushes.
  @SubscribeMessage("trip:subscribe")
  onTripSubscribe(@ConnectedSocket() client: AuthedSocket, @MessageBody() body: { tripId: string }) {
    client.join(`trip:${body.tripId}`);
  }

  @SubscribeMessage("trip:unsubscribe")
  onTripUnsubscribe(@ConnectedSocket() client: AuthedSocket, @MessageBody() body: { tripId: string }) {
    client.leave(`trip:${body.tripId}`);
  }

  // Used by TripsService to push an incoming offer straight to a specific driver's socket.
  //
  // `this.server` here is the /location Namespace instance (NestJS injects the
  // namespaced server, not the root Server, when @WebSocketGateway({ namespace })
  // is used — verified against @nestjs/platform-socket.io's io-adapter.js, which
  // calls `server.of(namespace)`). Namespace#sockets is already a
  // Map<SocketId, Socket> directly — NOT Server#sockets, which would itself be a
  // Namespace requiring a second `.sockets` to reach the map. Do not add an
  // extra `.sockets` here or this silently breaks (iterating undefined throws).
  emitToUser(userId: string, event: string, payload: unknown) {
    for (const [, socket] of this.server.sockets) {
      const s = socket as AuthedSocket;
      if (s.userId === userId) s.emit(event, payload);
    }
  }
}
