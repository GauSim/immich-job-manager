import { Injectable } from '@nestjs/common';
import type { IndexReadFilter } from '../../asset-index/asset-index.reader.js';
import { AlbumJobType } from '../../core/album-job-type.decorator.js';
import type {
  GroupContext,
  GroupJobType,
  ProposedGroup,
} from '../../core/job-type.js';
import { detectTrips, homePeriods } from './detect.js';
import { DEFAULT_TRIP_PARAMS, TripParams } from './trip.params.js';

/**
 * Trip albums (trip-albums SDD): one album per holiday trip, detected from
 * the date and location of photos and videos.
 */
@Injectable()
@AlbumJobType()
export class TripAlbumsJob implements GroupJobType<TripParams> {
  readonly kind = 'groups' as const;
  readonly id = 'trip-albums';
  readonly name = 'Trip albums';
  readonly description =
    'One album per trip away from home (another country by default), incl. travel days and camera photos without GPS';
  readonly version = 1;
  readonly params = TripParams;
  readonly defaultParams = DEFAULT_TRIP_PARAMS;

  indexFilter(params: TripParams, ownerId: string): IndexReadFilter {
    return {
      ownerId,
      includePartners: params.partnerAssets !== 'off',
      includeArchived: params.includeArchived,
      types: params.includeVideos ? undefined : ['IMAGE'],
    };
  }

  adoption(
    params: TripParams,
  ): { minShare: number; minCoverage: number } | null {
    return params.adoptExisting === 'auto'
      ? { minShare: params.advanced.adoptMinShare, minCoverage: 0.3 }
      : null;
  }

  group(ctx: GroupContext<TripParams>): ProposedGroup[] {
    const { trips, dropped } = detectTrips({
      assets: ctx.index.all(),
      ownerId: ctx.ownerId,
      params: ctx.params,
      now: ctx.now,
    });
    if (dropped.length) {
      const byReason = new Map<string, number>();
      for (const d of dropped)
        byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
      ctx.log.info(
        `${dropped.length} stretches away not counted as trips (${[...byReason].map(([r, n]) => `${r}: ${n}`).join(', ')})`,
      );
    }
    return trips.map((t) => ({
      key: t.key,
      start: new Date(t.start),
      end: new Date(t.end),
      coreStart: new Date(t.coreStart),
      coreEnd: new Date(t.coreEnd),
      ongoing: t.ongoing,
      name: t.name,
      summary: {
        countries: t.countries,
        cities: t.cities,
        days: t.days,
        localStart: t.localStart,
        localEnd: t.localEnd,
        startRule: t.startRule,
        endRule: t.endRule,
      },
      assets: t.assets,
    }));
  }

  /** Inferred home per month, for the job page. */
  insights(ctx: Omit<GroupContext<TripParams>, 'log' | 'signal'>): {
    home: ReturnType<typeof homePeriods>;
  } {
    const { home } = detectTrips({
      assets: ctx.index.all(),
      ownerId: ctx.ownerId,
      params: ctx.params,
      now: ctx.now,
    });
    const own = ctx.index.all().filter((a) => a.ownerId === ctx.ownerId);
    return { home: homePeriods(home, own) };
  }
}
