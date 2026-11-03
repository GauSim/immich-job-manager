import { PLACES, Timeline } from '../../../test/support/timeline.js';
import { detectTrips, type DetectedTrip } from './detect.js';
import { DEFAULT_TRIP_PARAMS, TripParams } from './trip.params.js';

const NOW = new Date('2026-11-03T12:00:00Z');

function detect(t: Timeline, params: Partial<TripParams> = {}, now = NOW) {
  return detectTrips({
    assets: t.assets,
    ownerId: 'me',
    params: TripParams.parse({ ...params }),
    now,
  });
}

const ids = (trip: DetectedTrip) => new Set(trip.assets.map((a) => a.assetId));
const reasonsOf = (trip: DetectedTrip, id: string) =>
  trip.assets.find((a) => a.assetId === id)?.reasons;

describe('detectTrips', () => {
  describe('Berlin → Bangkok with travel days', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-03-02', PLACES.berlinHome);
    const cameraAtHome = t.shot('2026-03-03T07:00', null, { noTimeZone: true });
    const lastAtHome = t.shot('2026-03-03T08:10', PLACES.berlinHome);
    const airport = t.shot('2026-03-03T13:40', PLACES.ber);
    const cameraAtAirport = t.shot('2026-03-03T14:05', null, {
      noTimeZone: true,
    });
    const firstAbroad = t.shot('2026-03-04T07:20', PLACES.bangkok);
    t.days('2026-03-04', '2026-03-09', PLACES.bangkok);
    t.days('2026-03-10', '2026-03-12', PLACES.chiangMai);
    t.days('2026-03-13', '2026-03-18', PLACES.bangkok);
    const cameraAbroad = t.shot('2026-03-08T12:00', null, { noTimeZone: true });
    const earlyCamera = t.shot('2026-03-04T06:00', null, { noTimeZone: true });
    const screenshot = t.shot('2026-03-08T13:00', null, {
      camera: false,
      screenshot: true,
      noTimeZone: true,
    });
    const messenger = t.shot('2026-03-08T14:00', null, {
      camera: false,
      noTimeZone: true,
    });
    const video = t.shot('2026-03-09T10:00', PLACES.bangkok, { type: 'VIDEO' });
    const departureGate = t.shot('2026-03-19T22:30', PLACES.bkk);
    const arrivalBer = t.shot('2026-03-20T06:45', PLACES.ber);
    const backHome = t.shot('2026-03-20T09:30', PLACES.berlinHome);
    t.days('2026-03-21', '2026-05-31', PLACES.berlinHome);

    const { trips, dropped } = detect(t);
    const [trip] = trips;

    it('finds exactly one trip', () => {
      expect(trips).toHaveLength(1);
      expect(dropped).toEqual([]);
    });

    it('starts right after the last photo at home and ends right before the next', () => {
      expect(trip.startRule).toBe('after-home');
      expect(trip.localStart).toBe('2026-03-03T08:10:00.001');
      expect(trip.endRule).toBe('after-home');
      expect(trip.localEnd).toBe('2026-03-20T09:29:59.999');
      expect(trip.coreStart).toBe(firstAbroad.takenAt);
      expect(trip.coreEnd).toBe(departureGate.takenAt);
      expect(trip.days).toBe(18);
      expect(trip.ongoing).toBe(false);
    });

    it('includes the airport photos and travel-day camera photos', () => {
      expect(reasonsOf(trip, airport.id)).toEqual([
        'gps-in-range',
        'transit-departure',
      ]);
      expect(reasonsOf(trip, cameraAtAirport.id)).toEqual([
        'no-gps-camera',
        'transit-departure',
      ]);
      expect(reasonsOf(trip, arrivalBer.id)).toEqual([
        'gps-in-range',
        'transit-return',
      ]);
    });

    it('fills camera photos without a time zone by local time', () => {
      expect(reasonsOf(trip, cameraAbroad.id)).toEqual(['no-gps-camera']);
      expect(ids(trip).has(earlyCamera.id)).toBe(true);
    });

    it('keeps out home photos, screenshots and messenger images', () => {
      const members = ids(trip);
      for (const a of [
        cameraAtHome,
        lastAtHome,
        backHome,
        screenshot,
        messenger,
      ])
        expect(members.has(a.id)).toBe(false);
    });

    it('includes videos', () => {
      expect(reasonsOf(trip, video.id)).toEqual(['gps-away']);
    });

    it('summarises places and names the album', () => {
      expect(trip.countries).toEqual(['Thailand']);
      // The airport district counts as a place visited (1 day).
      expect(trip.cities).toEqual(['Bangkok', 'Chiang Mai', 'Bang Phli']);
      expect(trip.name).toBe('Thailand – Mar 2026');
      // Key and name follow the days away, not the travel day before.
      expect(trip.key).toBe('trip:2026-03-04');
    });

    it('leaves videos out when asked', () => {
      const [noVideo] = detect(t, { includeVideos: false }).trips;
      expect(ids(noVideo).has(video.id)).toBe(false);
    });

    it('fills nothing without GPS when asked', () => {
      const [gpsOnly] = detect(t, { fillWithoutGps: 'none' }).trips;
      expect(ids(gpsOnly).has(cameraAbroad.id)).toBe(false);
      const [all] = detect(t, { fillWithoutGps: 'all' }).trips;
      expect(ids(all).has(messenger.id)).toBe(true);
    });
  });

  it('keeps a trip through several countries as one', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-03-31', PLACES.berlinHome);
    t.days('2026-04-01', '2026-04-05', PLACES.bangkok);
    t.days('2026-04-06', '2026-04-09', PLACES.siemReap);
    t.days('2026-04-10', '2026-06-30', PLACES.berlinHome);
    const { trips } = detect(t);
    expect(trips).toHaveLength(1);
    expect(trips[0].countries).toEqual(['Thailand', 'Cambodia']);
    expect(trips[0].name).toBe('Thailand & Cambodia – Apr 2026');
  });

  describe('domestic trip', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-03-31', PLACES.berlinHome);
    t.days('2026-04-01', '2026-04-04', PLACES.munich);
    t.days('2026-04-05', '2026-06-30', PLACES.berlinHome);

    it('is ignored by the default other-country rule', () => {
      expect(detect(t).trips).toEqual([]);
    });

    it('is found by the distance rule', () => {
      const { trips } = detect(t, { awayRule: 'distance' });
      expect(trips).toHaveLength(1);
      expect(trips[0].countries).toEqual(['Germany']);
      expect(trips[0].cities).toEqual(['Munich']);
    });
  });

  describe('day trip', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-03-31', PLACES.berlinHome);
    for (const h of ['10', '12', '14', '16', '18'])
      t.shot(`2026-04-01T${h}:00`, PLACES.prague);
    t.days('2026-04-01', '2026-06-30', PLACES.berlinHome);

    it('is too short by default (no night away)', () => {
      const { trips, dropped } = detect(t);
      expect(trips).toEqual([]);
      expect(dropped).toEqual([
        expect.objectContaining({
          reason: 'too-short',
          countries: ['Czechia'],
          awayAssets: 5,
        }),
      ]);
    });

    it('counts with minTripDays 1, bounded by the home photos of that day', () => {
      const [trip] = detect(t, { minTripDays: 1 }).trips;
      expect(trip.localStart).toBe('2026-04-01T09:00:00.001');
      expect(trip.localEnd).toBe('2026-04-01T18:59:59.999');
      expect(trip.assets).toHaveLength(5);
    });

    it('needs enough photos away', () => {
      const { dropped } = detect(t, {
        minTripDays: 1,
        advanced: { minAwayAssets: 6 },
      } as Partial<TripParams>);
      expect(dropped[0].reason).toBe('too-few-assets');
    });
  });

  it('does not turn a move abroad into a trip', () => {
    const t = new Timeline();
    t.days('2025-01-01', '2025-12-31', PLACES.berlinHome);
    t.days('2026-01-01', '2026-09-30', PLACES.amsterdam);
    expect(detect(t).trips).toEqual([]);
  });

  it('does not let a photo-heavy holiday become home', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-01-31', PLACES.berlinHome);
    for (let i = 0; i < 100; i++)
      t.days('2026-02-01', '2026-02-10', PLACES.bangkok);
    t.days('2026-02-11', '2026-02-28', PLACES.berlinHome);
    const { trips } = detect(t);
    expect(trips).toHaveLength(1);
    expect(trips[0].countries).toEqual(['Thailand']);
  });

  it('keeps an ongoing trip open and growing', () => {
    const t = new Timeline();
    t.days('2026-08-01', '2026-10-25', PLACES.berlinHome);
    t.days('2026-10-26', '2026-11-02', PLACES.bangkok);
    const [trip] = detect(t).trips;
    expect(trip.ongoing).toBe(true);
    expect(trip.endRule).toBe('core');
    expect(trip.end).toBeGreaterThanOrEqual(NOW.getTime());
    expect(trip.assets.some((a) => a.reasons.includes('transit-return'))).toBe(
      false,
    );
    // A week later without new photos it is no longer ongoing.
    const later = detect(t, {}, new Date('2026-11-10T12:00:00Z')).trips[0];
    expect(later.ongoing).toBe(false);
  });

  it('is not split by one wrongly geotagged photo', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-03-31', PLACES.berlinHome);
    t.days('2026-04-01', '2026-04-05', PLACES.bangkok);
    const stray = t.shot('2026-04-03T12:00', PLACES.berlinHome, {
      utcOffset: 7,
    });
    t.days('2026-04-06', '2026-06-30', PLACES.berlinHome);
    const { trips } = detect(t);
    expect(trips).toHaveLength(1);
    expect(reasonsOf(trips[0], stray.id)).toEqual(['gps-in-range']);
  });

  it('splits trips with a home stay between them, without overlap', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-03-31', PLACES.berlinHome);
    t.days('2026-04-01', '2026-04-05', PLACES.bangkok);
    t.days('2026-04-06', '2026-04-08', PLACES.berlinHome);
    t.days('2026-04-09', '2026-04-11', PLACES.prague);
    t.days('2026-04-12', '2026-06-30', PLACES.berlinHome);
    const { trips } = detect(t);
    expect(trips.map((x) => x.countries)).toEqual([['Thailand'], ['Czechia']]);
    expect(trips[0].end).toBeLessThan(trips[1].start);
  });

  it('puts every asset into at most one trip and is order-independent', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-03-31', PLACES.berlinHome);
    t.days('2026-04-01', '2026-04-05', PLACES.bangkok);
    t.days('2026-04-06', '2026-04-06', PLACES.berlinHome);
    t.days('2026-04-07', '2026-04-11', PLACES.prague);
    for (let d = 1; d <= 11; d++)
      t.shot(`2026-04-${String(d).padStart(2, '0')}T12:00`, null, {
        noTimeZone: true,
      });
    t.days('2026-04-12', '2026-06-30', PLACES.berlinHome);

    const a = detect(t);
    const seen = new Set<string>();
    for (const trip of a.trips)
      for (const { assetId } of trip.assets) {
        expect(seen.has(assetId)).toBe(false);
        seen.add(assetId);
      }
    const shuffled = new Timeline();
    shuffled.assets.push(...[...t.assets].reverse());
    expect(detect(shuffled).trips).toEqual(a.trips);
  });

  describe('partner assets', () => {
    const t = new Timeline();
    t.days('2026-01-01', '2026-03-31', PLACES.berlinHome);
    t.days('2026-04-01', '2026-04-05', PLACES.bangkok);
    const partnerOnTrip = t.shot('2026-04-03T15:00', PLACES.bangkok, {
      ownerId: 'partner',
    });
    t.days('2026-04-06', '2026-06-30', PLACES.berlinHome);
    // The partner travels alone later.
    t.days('2026-07-01', '2026-07-05', PLACES.siemReap, { ownerId: 'partner' });

    it('join own trips but start none (fill)', () => {
      const { trips } = detect(t);
      expect(trips).toHaveLength(1);
      expect(reasonsOf(trips[0], partnerOnTrip.id)).toEqual([
        'gps-away',
        'partner',
      ]);
    });

    it('can start trips (full)', () => {
      expect(detect(t, { partnerAssets: 'full' }).trips).toHaveLength(2);
    });

    it('are ignored (off)', () => {
      const [trip] = detect(t, { partnerAssets: 'off' }).trips;
      expect(ids(trip).has(partnerOnTrip.id)).toBe(false);
    });
  });

  it('skips trips before minimumYear', () => {
    const t = new Timeline();
    t.days('2019-01-01', '2019-03-31', PLACES.berlinHome);
    t.days('2019-04-01', '2019-04-05', PLACES.bangkok);
    t.days('2019-04-06', '2019-06-30', PLACES.berlinHome);
    const { trips, dropped } = detect(t, { minimumYear: 2020 });
    expect(trips).toEqual([]);
    expect(dropped[0].reason).toBe('before-minimum-year');
  });

  it('uses the defaults from the schema', () => {
    expect(TripParams.parse({})).toEqual(DEFAULT_TRIP_PARAMS);
    expect(DEFAULT_TRIP_PARAMS.advanced.maxTransitHours).toBe(24);
  });
});
