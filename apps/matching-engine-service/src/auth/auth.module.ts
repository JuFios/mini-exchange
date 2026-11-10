import { RateLimitModule } from '../security/rate-limit.module';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { User } from './entities/user.entity';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AdminSeedService } from './admin-seed.service';
import { RolesGuard } from './guards/roles.guard';
import { InternalSessionController } from './internal-session.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User]), JwtModule.register({}), RateLimitModule],
  controllers: [AuthController, InternalSessionController],
  providers: [AdminSeedService, AuthService, JwtStrategy, RolesGuard],
  exports: [AuthService, JwtStrategy, RolesGuard],
})
export class AuthModule {}
