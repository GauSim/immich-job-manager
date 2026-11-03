import { albumUrl, groupRange } from './trips-panel';

describe('trips panel helpers', () => {
  it('links albums in the Immich web UI', () => {
    expect(albumUrl('http://immich:2283/api', 'abc')).toBe('http://immich:2283/albums/abc');
    expect(albumUrl('http://immich:2283/api/', 'abc')).toBe('http://immich:2283/albums/abc');
    expect(albumUrl(undefined, 'abc')).toBeNull();
  });

  it('shows the local trip range, else the core range', () => {
    const base = { coreStart: '2026-03-04T00:20:00.000Z', coreEnd: '2026-03-19T15:30:00.000Z' };
    expect(groupRange({ ...base, summary: {} })).toMatch(/2026/);
    expect(
      groupRange({
        ...base,
        summary: { localStart: '2026-03-03T08:00:00.000', localEnd: '2026-03-03T20:00:00.000' },
      }),
    ).not.toMatch(/–/);
  });
});
