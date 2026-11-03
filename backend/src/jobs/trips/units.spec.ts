import { PLACES, Timeline } from '../../../test/support/timeline.js';
import { isAway } from './away.js';
import { distanceKm, localDayNumber } from './geo-time.js';
import { HomeModel } from './home.js';
import { joinNames, period, renderName } from './naming.js';
import { segment } from './segment.js';
import { arrival, departure } from './transit.js';

const TRANSIT = { maxTransitHours: 24, transitSpeedKmh: 200, homeRadiusKm: 3 };

describe('naming', () => {
  const ctx = {
    countries: ['Thailand', 'Cambodia'],
    cities: ['Bangkok', 'Siem Reap'],
    start: '2026-03-04',
    end: '2026-03-19',
    days: 16,
  };

  it('joins names', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A & B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B & C');
    expect(joinNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C +2');
  });

  it('formats periods', () => {
    expect(period('2026-03-04', '2026-03-19', 'en')).toBe('Mar 2026');
    expect(period('2026-03-28', '2026-04-03', 'en')).toBe('Mar – Apr 2026');
    expect(period('2025-12-28', '2026-01-03', 'en')).toBe(
      'Dec 2025 – Jan 2026',
    );
    expect(period('2026-03-04', '2026-03-19', 'de')).toMatch(/^Mär\S* 2026$/);
  });

  it('renders all placeholders', () => {
    expect(
      renderName(
        '{start}..{end} {days}d {year}/{month}: {country} | {countries} ({cities}) {unknown}',
        ctx,
      ),
    ).toBe(
      '2026-03-04..2026-03-19 16d 2026/Mar: Thailand | Thailand & Cambodia (Bangkok & Siem Reap) {unknown}',
    );
  });

  it('drops empty placeholders with their separator', () => {
    const none = { ...ctx, countries: [], cities: [] };
    expect(renderName('{countries} – {period}', none)).toBe('Mar 2026');
    expect(renderName('{period} – {countries}', none)).toBe('Mar 2026');
    expect(renderName('{year} – {cities} – {country}', none)).toBe('2026');
    expect(renderName('{cities}', none)).toBe('Trip 2026-03-04');
  });

  it('falls back to English for an unknown locale', () => {
    expect(period('2026-03-04', '2026-03-19', 'not a locale!')).toBe(
      'Mar 2026',
    );
  });
});

describe('HomeModel', () => {
  it('finds the home country and place per day', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-03-31', PLACES.berlinHome);
    const home = new HomeModel(t.assets, 60);
    const h = home.of(t.assets[50]);
    expect(h.country).toBe('Germany');
    expect(h.places).toHaveLength(1);
    expect(
      distanceKm(
        h.places[0].latitude,
        h.places[0].longitude,
        PLACES.berlinHome.latitude,
        PLACES.berlinHome.longitude,
      ),
    ).toBeLessThan(0.1);
  });

  it('keeps a frequent second place (office) as home', () => {
    const t = new Timeline();
    for (let d = 1; d <= 28; d++) {
      const day = `2026-02-${String(d).padStart(2, '0')}`;
      t.shot(`${day}T08:00`, PLACES.berlinHome);
      if (d % 2 === 0) t.shot(`${day}T12:00`, PLACES.berlinOffice);
    }
    const home = new HomeModel(t.assets, 60);
    expect(home.of(t.assets[0]).places).toHaveLength(2);
    const office = t.shot('2026-02-10T13:00', PLACES.berlinOffice);
    expect(home.isAtHomePlace(office, 3)).toBe(true);
  });

  it('widens the window for sparse data', () => {
    const t = new Timeline();
    t.days('2020-01-01', '2020-01-10', PLACES.berlinHome);
    const later = t.shot('2020-12-01T10:00', PLACES.bangkok);
    const home = new HomeModel(t.assets, 60);
    expect(home.of(later).country).toBe('Germany');
  });

  it('has no home without GPS data', () => {
    const t = new Timeline();
    const a = t.shot('2026-01-01T10:00', null);
    const home = new HomeModel(t.assets, 60);
    expect(home.at(localDayNumber(a))).toEqual({ country: null, places: [] });
    expect(home.distanceFromHome(a)).toBeNull();
  });
});

describe('isAway', () => {
  const t = new Timeline();
  t.days('2026-01-01', '2026-03-31', PLACES.berlinHome);
  const home = new HomeModel(t.assets, 60);
  const at = (place: (typeof PLACES)[keyof typeof PLACES]) =>
    new Timeline().shot('2026-02-15T12:00', place);
  const rule = (awayRule: 'other-country' | 'distance' | 'either') => ({
    awayRule,
    minDistanceKm: 100,
  });

  it('other-country: another country is away, the home country is not', () => {
    expect(isAway(at(PLACES.prague), home, rule('other-country'))).toBe(true);
    expect(isAway(at(PLACES.munich), home, rule('other-country'))).toBe(false);
  });

  it('decides by distance when there is no country (at sea)', () => {
    expect(isAway(at(PLACES.atSea), home, rule('other-country'))).toBe(true);
  });

  it('distance and either', () => {
    expect(isAway(at(PLACES.munich), home, rule('distance'))).toBe(true);
    expect(isAway(at(PLACES.ber), home, rule('distance'))).toBe(false);
    expect(isAway(at(PLACES.munich), home, rule('either'))).toBe(true);
  });

  it('never for assets without GPS', () => {
    expect(isAway(at(null as never), home, rule('either'))).toBe(false);
  });
});

describe('segment', () => {
  const t = new Timeline();
  const away = new Set<string>();
  const out = (local: string) => {
    const a = t.shot(local, PLACES.bangkok);
    away.add(a.id);
  };
  const home = (local: string) => t.shot(local, PLACES.berlinHome);
  out('2026-04-01T10:00');
  out('2026-04-02T10:00');
  home('2026-04-02T20:00'); // single home point: no split
  out('2026-04-03T10:00');
  home('2026-04-04T10:00');
  home('2026-04-05T11:00'); // home stay > 24 h: split
  out('2026-04-06T10:00');
  out('2026-04-10T11:00'); // gap > 72 h: split
  const segs = segment(t.assets, (a) => away.has(a.id), {
    maxGapHours: 72,
    homeStayHours: 24,
  });

  it('splits on home stays and gaps only', () => {
    expect(segs.map((s) => [s.away.length, s.closedBy])).toEqual([
      [3, 'home-stay'],
      [1, 'gap'],
      [1, 'end'],
    ]);
  });
});

describe('travel days', () => {
  it('uses the speed check without a photo at home: flight → full transit window', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-02-28', PLACES.berlinHome);
    // No home photo on the departure day; evening at the airport, landing next morning.
    const gate = t.shot('2026-03-02T21:00', PLACES.ber);
    const landed = t.shot('2026-03-03T14:00', PLACES.bangkok);
    const gps = t.assets;
    const home = new HomeModel(gps, 60);
    const start = departure(gps, gps.indexOf(landed), home, TRANSIT);
    expect(start.rule).toBe('transit-point');
    expect(start.instant).toBe(gate.takenAt);
  });

  it('without a jump, extends only to the start of the same local day', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-02-27', PLACES.berlinHome);
    t.shot('2026-02-28T19:00', PLACES.ber); // previous evening, not at home
    const first = t.shot('2026-03-01T15:00', PLACES.prague); // drove: no jump
    const gps = t.assets;
    const home = new HomeModel(gps, 60);
    const start = departure(gps, gps.indexOf(first), home, TRANSIT);
    expect(start.rule).toBe('local-day');
    expect(start.local).toBe('2026-03-01T00:00:00.000');
  });

  it('return: ends right before the first photo at home', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-02-28', PLACES.berlinHome);
    const last = t.shot('2026-03-01T10:00', PLACES.prague);
    t.shot('2026-03-01T15:00', PLACES.ber);
    const home1 = t.shot('2026-03-01T18:00', PLACES.berlinHome);
    const gps = t.assets;
    const home = new HomeModel(gps, 60);
    const end = arrival(gps, gps.indexOf(last), home, TRANSIT);
    expect(end.rule).toBe('after-home');
    expect(end.instant).toBe(home1.takenAt - 1);
  });

  it('return without photos afterwards: end of the local day', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-02-28', PLACES.berlinHome);
    const last = t.shot('2026-03-01T10:00', PLACES.prague);
    const gps = t.assets;
    const end = arrival(
      gps,
      gps.indexOf(last),
      new HomeModel(gps, 60),
      TRANSIT,
    );
    expect(end.rule).toBe('local-day');
    expect(end.local).toBe('2026-03-01T23:59:59.999');
  });
});
