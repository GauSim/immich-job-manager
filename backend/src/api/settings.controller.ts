import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import {
  SettingsService,
  type SettingKey,
} from '../settings/settings.service.js';
import { APP_VERSION } from '../version.js';
import { UpdateSettingsDto } from './dto.js';
import { ZodPipe } from './validation.js';

export interface SettingsView {
  settings: Record<SettingKey, number>;
  /** Read-only facts from the environment (no secrets). */
  app: {
    version: string;
    authMode: AppConfig['auth']['mode'];
    timeZone: string;
    maxConcurrentRuns: number;
    maxFileReads: number;
    immichUrl: string;
  };
}

/** Runtime settings (SDD §10): retention and defaults; connection settings stay env-only. */
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  get(): SettingsView {
    return {
      settings: this.settings.all(),
      app: {
        version: APP_VERSION,
        authMode: this.config.auth.mode,
        timeZone: this.config.tz,
        maxConcurrentRuns: this.config.maxConcurrentRuns,
        maxFileReads: this.config.maxFileReads,
        immichUrl: this.config.immich.url,
      },
    };
  }

  @Patch()
  update(
    @Body(new ZodPipe(UpdateSettingsDto)) dto: UpdateSettingsDto,
  ): SettingsView {
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) this.settings.set(key as SettingKey, value);
    }
    return this.get();
  }
}
