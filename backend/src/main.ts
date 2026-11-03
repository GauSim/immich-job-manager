import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import {
  ConfigError,
  loadConfig,
  type AppConfig,
} from './config/config.schema.js';

/** Development convenience: load ./.env if present (Docker passes env directly). */
if (existsSync('.env')) process.loadEnvFile('.env');

function configOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`${e.message}\n\nSee .env.example for all settings.`);
      process.exit(1);
    }
    throw e;
  }
}

async function bootstrap() {
  const config = configOrExit();
  process.env.TZ = config.tz;

  const app = await NestFactory.create(AppModule.register(config), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.listen(config.port);
}
await bootstrap();
