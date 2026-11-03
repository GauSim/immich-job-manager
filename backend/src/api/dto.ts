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

/** Job fields without defaults (shared by create and update). */
const jobFields = {
  name,
  typeId: z.string().min(1, 'is required'),
  /** Required for asset jobs; group jobs (e.g. trip albums) create one album per group. */
  targetAlbumName: name.optional(),
  /** null/omitted → `<target> – excluded` (group jobs: `<job name> – excluded`) */
  exclusionAlbumName: name.nullish(),
  params: z.record(z.string(), z.unknown()),
  syncMode: z.enum(SYNC_MODES),
  schedule: cron.nullish(),
  enabled: z.boolean(),
};

export const CreateJobDto = z.strictObject({
  ...jobFields,
  params: jobFields.params.default({}),
  syncMode: jobFields.syncMode.default('dry-run'),
  enabled: jobFields.enabled.default(false),
});
export type CreateJobDto = z.infer<typeof CreateJobDto>;

/**
 * Like create, all optional; the job type cannot change. `params` replaces the
 * stored params. Built without defaults: with Zod 4, defaults inside
 * `.partial()` still apply, so a PATCH of one field reset `syncMode` and
 * `enabled`.
 */
export const UpdateJobDto = z
  .strictObject(jobFields)
  .omit({ typeId: true })
  .partial();
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

const score = z.coerce.number().min(0).max(1);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** `GET /runs/:id/candidates` — score band: `minScore` inclusive, `maxScore` exclusive. */
export const CandidateQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['-score', 'score', 'name']).default('-score'),
  minScore: score.optional(),
  maxScore: score.optional(),
  selected: bool.optional(),
  /** Group jobs: only the assets of this proposed group (`run_group.group_key`). */
  group: z.string().min(1).max(200).optional(),
});
export type CandidateQuery = z.infer<typeof CandidateQuery>;

/**
 * `PATCH /runs/:id/candidates` — tick or untick candidates, either by id or
 * by filter (score band / current state). With neither, applies to all.
 */
export const UpdateCandidatesDto = z
  .strictObject({
    selected: z.boolean(),
    assetIds: z.array(z.string().min(1)).min(1).max(10_000).optional(),
    filter: z
      .strictObject({
        minScore: score.optional(),
        maxScore: score.optional(),
        selected: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((v) => !(v.assetIds && v.filter), {
    error: 'use either assetIds or filter, not both',
  });
export type UpdateCandidatesDto = z.infer<typeof UpdateCandidatesDto>;

/** `POST /jobs/import` — the body of `GET /jobs/export`. */
export const ImportJobsDto = z.object({
  app: z.literal('immich-album-jobs').optional(),
  version: z.literal(1).optional(),
  jobs: z.array(z.unknown()).min(1).max(1000),
});
export type ImportJobsDto = z.infer<typeof ImportJobsDto>;

export const UpdateSettingsDto = z.strictObject({
  'retention.dryRunCandidates': z.number().int().min(1).max(100).optional(),
  'retention.logDays': z.number().int().min(1).max(3650).optional(),
  'defaults.threshold': z.number().min(0).max(1).optional(),
});
export type UpdateSettingsDto = z.infer<typeof UpdateSettingsDto>;

/** `PATCH /runs/:id/groups` — tick or untick proposed groups (all when `keys` is omitted). */
export const UpdateRunGroupsDto = z
  .strictObject({
    selected: z.boolean().optional(),
    /** `create` groups with a proposed existing album: adopt it (true) or create a new album (false). Needs `keys`. */
    adopt: z.boolean().optional(),
    keys: z.array(z.string().min(1)).min(1).max(10_000).optional(),
  })
  .refine((v) => v.selected !== undefined || v.adopt !== undefined, {
    error: 'set selected and/or adopt',
  })
  .refine((v) => v.adopt === undefined || v.keys, {
    error: 'adopt needs keys',
    path: ['keys'],
  });
export type UpdateRunGroupsDto = z.infer<typeof UpdateRunGroupsDto>;

/** `PATCH /jobs/:id/groups/:groupId` — user decision on a stored group. */
export const UpdateJobGroupDto = z.strictObject({
  status: z.enum(['active', 'ignored', 'locked']),
});
export type UpdateJobGroupDto = z.infer<typeof UpdateJobGroupDto>;
