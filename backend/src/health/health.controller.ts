import { Controller, Get, HttpStatus, Req, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { Public } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { APP_VERSION } from '../version.js';
import { DataSource } from 'typeorm';
import { ImmichClient, SUPPORTED_MAJOR } from '../immich/immich.client.js';
import { ImmichError } from '../immich/immich.errors.js';

export interface HealthResponse {
  /** ok: everything up · degraded: app works, Immich down/incompatible · error: database down */
  status: 'ok' | 'degraded' | 'error';
  /** App version. */
  version: string;
  database: { status: 'up' | 'down'; error?: string };
  immich: {
    status: 'up' | 'down' | 'incompatible';
    version?: string;
    error?: string;
    correlationId?: string;
  };
}

/**
 * Liveness and dependency status. Answers 200 unless the database is down,
 * so the container stays healthy while Immich restarts; Immich state is in the body.
 */
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly immich: ImmichClient,
    private readonly auth: AuthService,
  ) {}

  /** Public (Docker healthcheck); details only with a session or in forward-auth mode. */
  @Public()
  @Get()
  async getHealth(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthResponse | Pick<HealthResponse, 'status' | 'version'>> {
    const [database, immich] = await Promise.all([
      this.checkDatabase(),
      this.checkImmich(),
    ]);
    const status =
      database.status === 'down'
        ? 'error'
        : immich.status === 'up'
          ? 'ok'
          : 'degraded';
    res.status(
      status === 'error' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK,
    );
    if (!this.auth.isAuthenticated(req))
      return { status, version: APP_VERSION };
    return { status, version: APP_VERSION, database, immich };
  }

  private async checkDatabase(): Promise<HealthResponse['database']> {
    try {
      await this.db.query('SELECT 1');
      return { status: 'up' };
    } catch (e) {
      return { status: 'down', error: (e as Error).message };
    }
  }

  private async checkImmich(): Promise<HealthResponse['immich']> {
    try {
      const v = await this.immich.getVersion({ retry: false, timeoutMs: 3000 });
      return v.major === SUPPORTED_MAJOR
        ? { status: 'up', version: v.version }
        : {
            status: 'incompatible',
            version: v.version,
            error: `requires Immich v${SUPPORTED_MAJOR}.x`,
          };
    } catch (e) {
      return {
        status: 'down',
        error: (e as Error).message,
        correlationId: e instanceof ImmichError ? e.correlationId : undefined,
      };
    }
  }
}
