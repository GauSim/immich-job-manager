import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';

const PUBLIC = 'iaj:public';
/** Route reachable without a session (health, login). */
export const Public = () => SetMetadata(PUBLIC, true);

/** Global guard: every API route needs a session unless marked `@Public()`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    if (this.auth.isAuthenticated(context.switchToHttp().getRequest<Request>()))
      return true;
    throw new UnauthorizedException('Login required');
  }
}
