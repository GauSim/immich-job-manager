import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../api/validation.js';
import { Public } from './auth.guard.js';
import { AuthService, SESSION_COOKIE, isHttps } from './auth.service.js';

const LoginDto = z.strictObject({
  password: z.string().min(1, 'is required').max(1000),
});
type LoginDto = z.infer<typeof LoginDto>;

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Who am I: `{ mode, authenticated }` (public; the UI decides whether to show the login page). */
  @Public()
  @Get('session')
  session(@Req() req: Request): { mode: string; authenticated: boolean } {
    return {
      mode: this.auth.mode,
      authenticated: this.auth.isAuthenticated(req),
    };
  }

  @Public()
  @Post('login')
  @HttpCode(204)
  login(
    @Body(new ZodPipe(LoginDto)) dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): void {
    if (!this.auth.enabled) return; // forward-auth: nothing to do
    const client = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const wait = this.auth.lockedFor(client);
    if (wait > 0) {
      res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
      throw new HttpException(
        'Too many failed logins; try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!this.auth.checkPassword(dto.password)) {
      this.auth.recordFailure(client);
      throw new UnauthorizedException('Wrong password');
    }
    this.auth.clearFailures(client);
    const { token, maxAgeSeconds } = this.auth.issue();
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: isHttps(req),
      path: '/',
      maxAge: maxAgeSeconds * 1000,
    });
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): void {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'strict',
      secure: isHttps(req),
      path: '/',
    });
  }
}
