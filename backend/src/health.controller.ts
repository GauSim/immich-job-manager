import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  status: 'ok';
}

/**
 * Placeholder liveness endpoint so the Docker healthcheck works from phase 0.
 * Phase 1 extends it with DB and Immich reachability/version checks.
 */
@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }
}
