import { z } from 'zod';

/** Fine-tuning; defaults fit a typical phone library (trip-albums SDD §6). */
export const TripAdvancedParams = z.object({
  homeWindowDays: z
    .number()
    .int()
    .min(7)
    .max(365)
    .default(60)
    .describe(
      'Home is the most frequent country / place within ± this many days (weighted by days, not photos)',
    ),
  homeRadiusKm: z
    .number()
    .min(0.1)
    .max(50)
    .default(3)
    .describe(
      '"At home" for travel days: within this distance of a home place',
    ),
  minAwayAssets: z
    .number()
    .int()
    .min(1)
    .default(5)
    .describe('A trip needs at least this many photos/videos with GPS away'),
  maxTripDays: z
    .number()
    .int()
    .min(1)
    .default(60)
    .describe('Longer stays away are not trips (e.g. moving abroad)'),
  maxGapHours: z
    .number()
    .min(1)
    .default(72)
    .describe(
      'A gap without photos away longer than this ends a trip (a new one starts)',
    ),
  homeStayHours: z
    .number()
    .min(1)
    .default(24)
    .describe('Being home this long between photos away ends a trip'),
  maxTransitHours: z
    .number()
    .min(0)
    .max(72)
    .default(24)
    .describe(
      'Travel days: extend a trip by at most this much before the first and after the last photo away',
    ),
  transitSpeedKmh: z
    .number()
    .min(10)
    .default(200)
    .describe(
      'Faster than this between two photos means a flight or train (travel day)',
    ),
  ongoingGraceDays: z
    .number()
    .min(0)
    .default(3)
    .describe(
      'A trip whose last photo away is newer than this (and no return yet) is still ongoing',
    ),
  adoptMinShare: z
    .number()
    .min(0)
    .max(1)
    .default(0.8)
    .describe(
      'Reuse an existing album when this share of its assets lies within the trip',
    ),
});
export type TripAdvancedParams = z.infer<typeof TripAdvancedParams>;

export const TripParams = z.object({
  awayRule: z
    .enum(['other-country', 'distance', 'either'])
    .default('other-country')
    .describe(
      'Away from home means: another country, more than the minimum distance from home, or either',
    ),
  minDistanceKm: z
    .number()
    .min(1)
    .default(100)
    .describe('Minimum distance from home for the distance rule'),
  minTripDays: z
    .number()
    .int()
    .min(1)
    .default(2)
    .describe('Minimum calendar days away (2 = at least one night)'),
  fillWithoutGps: z
    .enum(['camera', 'all', 'none'])
    .default('camera')
    .describe(
      'Photos without GPS taken during a trip: camera photos only, all, or none',
    ),
  includeVideos: z.boolean().default(true).describe('Include videos'),
  includeArchived: z
    .boolean()
    .default(false)
    .describe('Also use archived assets'),
  partnerAssets: z
    .enum(['fill', 'full', 'off'])
    .default('fill')
    .describe(
      "Partner's shared photos: join your trips (fill), can also start trips (full), or off",
    ),
  nameTemplate: z
    .string()
    .min(1)
    .default('{countries} – {period}')
    .describe(
      'Album name. Placeholders: {countries} {country} {cities} {period} {year} {month} {start} {end} {days}',
    ),
  locale: z
    .string()
    .min(2)
    .default('en')
    .describe('Language for month names, e.g. en or de'),
  adoptExisting: z
    .enum(['auto', 'off'])
    .default('auto')
    .describe('Reuse an existing album that already covers a trip'),
  minimumYear: z
    .number()
    .int()
    .min(1900)
    .optional()
    .describe('Ignore trips before this year'),
  advanced: TripAdvancedParams.prefault({}),
});
export type TripParams = z.infer<typeof TripParams>;

export const DEFAULT_TRIP_PARAMS: TripParams = TripParams.parse({});
