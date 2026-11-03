import {
  Global,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { ImmichClient } from './immich.client.js';
import { ImmichIncompatibleError } from './immich.errors.js';

/** Max concurrent metadata/album requests against Immich (SDD §5.4). */
export const IMMICH_API_CONCURRENCY = 2;

/**
 * Checks the Immich version on boot.
 * - Incompatible major version → boot fails.
 * - Immich unreachable → warning only; Immich may simply start after us.
 *   `/api/health` reports it, and runs check again before they start.
 */
@Injectable()
export class ImmichCompatibilityCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('Immich');

  constructor(private readonly immich: ImmichClient) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const v = await this.immich.assertCompatible({
        retry: false,
        timeoutMs: 10_000,
      });
      this.logger.log(`Connected to Immich ${v.version}`);
    } catch (e) {
      if (e instanceof ImmichIncompatibleError) throw e;
      this.logger.warn(`Immich not reachable at boot: ${(e as Error).message}`);
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: ImmichClient,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new ImmichClient({
          baseUrl: config.immich.url,
          apiKey: config.immich.apiKey,
          apiConcurrency: IMMICH_API_CONCURRENCY,
          fileConcurrency: config.maxFileReads,
        }),
    },
    ImmichCompatibilityCheck,
  ],
  exports: [ImmichClient],
})
export class ImmichModule {}
