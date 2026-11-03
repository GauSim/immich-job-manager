import { DynamicModule, Global, Module } from '@nestjs/common';
import type { AppConfig } from './config.schema.js';

/** Injection token for the validated {@link AppConfig}. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Provides the already-validated config. Validation happens in `main.ts`
 * before Nest starts, so an invalid environment never gets this far.
 */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
