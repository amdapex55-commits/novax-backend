import { Global, Module } from "@nestjs/common";
import { TokenDenylistService } from "./token-denylist.service";

// @Global because the three places that touch it — JwtStrategy (reads),
// UsersService (deletion) and AdminService (suspension) — sit in three
// different modules, and routing it through AuthModule would mean UsersModule
// and AdminModule importing the whole auth graph to reach one Redis key.
@Global()
@Module({
  providers: [TokenDenylistService],
  exports: [TokenDenylistService],
})
export class TokenDenylistModule {}
