import { validateCronExpression } from 'cron';
import { z } from 'zod';
import { SYNC_MODES } from '../persistence/entities/index.js';

const name = z.string().trim().min(1, 'is required').max(200);

const cron = z
  .string()
  .trim()
  .refine((v) => validateCronExpression(v).valid, {
    error: 'must be a valid cron expression, e.g. "0 3 * * *"',
  });

export const CreateJobDto = z.strictObject({
  name,
  typeId: z.string().min(1, 'is required'),
  targetAlbumName: name,
  /** null/omitted → `<target> – excluded` */
  exclusionAlbumName: name.nullish(),
  params: z.record(z.string(), z.unknown()).default({}),
  syncMode: z.enum(SYNC_MODES).default('dry-run'),
  schedule: cron.nullish(),
  enabled: z.boolean().default(false),
});
export type CreateJobDto = z.infer<typeof CreateJobDto>;

/** Like create, all optional; the job type cannot change. `params` replaces the stored params. */
export const UpdateJobDto = CreateJobDto.omit({ typeId: true })
  .partial()
  .strict();
export type UpdateJobDto = z.infer<typeof UpdateJobDto>;

export const StartRunDto = z.strictObject({
  /** Default: true when the job's sync mode is `dry-run`. */
  dryRun: z.boolean().optional(),
  fullRescan: z.boolean().default(false),
});
export type StartRunDto = z.infer<typeof StartRunDto>;

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const LogQuery = z.object({
  /** Only lines with id > after (incremental polling). */
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export type LogQuery = z.infer<typeof LogQuery>;
