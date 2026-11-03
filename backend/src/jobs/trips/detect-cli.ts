/**
 * Trip detection tuning CLI (trip-albums plan, phase T2). Runs the same
 * detection as the job over a raw index export and prints the trips, without
 * touching Immich. Your GPS history stays on your machine.
 *
 *   npm run trips:detect -- <trips-index.json> [params.json] [--now ISO] [--json out.json] [--verbose]
 *
 * `trips-index.json`: from `tools/immich-spike` `npm run trips` (out/).
 * `params.json`: optional job params (same shape as the job's params), e.g.
 *   { "minTripDays": 1, "advanced": { "maxGapHours": 48 } }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { matchesFilter } from '../../asset-index/asset-index.reader.js';
import { detectTrips, homePeriods, type DetectedTrip } from './detect.js';
import { EXPORT_OWNER, fromIndexExport } from './index-export.js';
import { TripParams } from './trip.params.js';

interface Args {
  index: string;
  params?: string;
  now?: string;
  json?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const args: Partial<Args> = { verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--now') args.now = argv[++i];
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') usage(0);
    else positional.push(a);
  }
  if (positional.length < 1 || positional.length > 2) usage(2);
  return { ...args, index: positional[0], params: positional[1] } as Args;
}

function usage(code: number): never {
  console.log(
    'Usage: npm run trips:detect -- <trips-index.json> [params.json] [--now ISO] [--json out.json] [--verbose]',
  );
  process.exit(code);
}

const short = (local: string) => local.slice(0, 16).replace('T', ' ');

function counts(trip: DetectedTrip) {
  const c = { gps: 0, noGps: 0, transit: 0, partner: 0 };
  for (const { reasons } of trip.assets) {
    if (reasons.includes('gps-away') || reasons.includes('gps-in-range'))
      c.gps++;
    else c.noGps++;
    if (
      reasons.includes('transit-departure') ||
      reasons.includes('transit-return')
    )
      c.transit++;
    if (reasons.includes('partner')) c.partner++;
  }
  return c;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const params = TripParams.parse(
    args.params ? JSON.parse(readFileSync(args.params, 'utf8')) : {},
  );
  const now = args.now ? new Date(args.now) : new Date();
  const t0 = Date.now();
  const all = fromIndexExport(JSON.parse(readFileSync(args.index, 'utf8')));
  const assets = all.filter((a) =>
    matchesFilter(a, {
      ownerId: EXPORT_OWNER,
      includePartners: params.partnerAssets !== 'off',
      includeArchived: params.includeArchived,
    }),
  );
  const result = detectTrips({ assets, ownerId: EXPORT_OWNER, params, now });
  const ms = Date.now() - t0;

  const own = assets.filter((a) => a.ownerId === EXPORT_OWNER);
  const ownGps = own.filter((a) => a.latitude !== null).length;
  console.log(
    `${all.length} assets in the export, ${assets.length} used (${own.length} own, ${ownGps} own with GPS); detection took ${ms} ms`,
  );

  console.log('\nHome (per month):');
  for (const p of homePeriods(result.home, own)) {
    const range = p.from === p.to ? p.from : `${p.from} … ${p.to}`;
    console.log(
      `  ${range.padEnd(19)} ${p.country ?? '(unknown)'}${p.place ? `  near ${p.place}` : ''}`,
    );
  }

  console.log(`\n${result.trips.length} trips:`);
  result.trips.forEach((trip, i) => {
    const c = counts(trip);
    console.log(
      `${String(i + 1).padStart(4)}  ${short(trip.localStart)} → ${short(trip.localEnd)}  ${String(trip.days).padStart(3)}d  ` +
        `${trip.name}${trip.ongoing ? '  (ongoing)' : ''}`,
    );
    console.log(
      `        ${trip.cities.join(', ') || '–'} · ${trip.assets.length} assets (gps ${c.gps}, no gps ${c.noGps}, travel days ${c.transit}${c.partner ? `, partner ${c.partner}` : ''}) · start: ${trip.startRule}, end: ${trip.endRule}`,
    );
  });

  const byReason = new Map<string, number>();
  for (const d of result.dropped)
    byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
  console.log(
    `\n${result.dropped.length} stretches away not counted as trips${
      byReason.size
        ? ` (${[...byReason].map(([r, n]) => `${r}: ${n}`).join(', ')})`
        : ''
    }${result.dropped.length && !args.verbose ? '; --verbose lists them' : ''}`,
  );
  if (args.verbose)
    for (const d of result.dropped)
      console.log(
        `        ${short(d.localStart)} → ${short(d.localEnd)}  ${d.countries.join(', ') || '?'}  ${d.awayAssets} away  ${d.reason}`,
      );

  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify(
        {
          params,
          trips: result.trips.map(({ assets: members, ...trip }) => ({
            ...trip,
            assetCount: members.length,
            assets: members,
          })),
          dropped: result.dropped,
        },
        null,
        2,
      ),
    );
    console.log(`\nwritten to ${args.json}`);
  }
}

main();
