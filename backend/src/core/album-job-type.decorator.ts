import { DiscoveryService } from '@nestjs/core';

/**
 * Marks a provider as a job type. Register the class as a provider in
 * `JobTypesModule`; `JobTypeRegistry` discovers it at boot.
 *
 * ```ts
 * @Injectable()
 * @AlbumJobType()
 * export class ScreenshotJob implements JobType<ScreenshotParams> { … }
 * ```
 */
export const AlbumJobType = DiscoveryService.createDecorator<void>();
