import type { IndexedAsset } from '../../asset-index/asset-index.mapping.js';
import { hasGps } from './geo-time.js';
import type { HomeModel } from './home.js';
import type { TripParams } from './trip.params.js';

/**
 * Away rule (trip-albums SDD §5.2) for an asset with GPS, compared to the home
 * of its local day. Without a known home nothing is away.
 */
export function isAway(
  asset: IndexedAsset,
  home: HomeModel,
  params: Pick<TripParams, 'awayRule' | 'minDistanceKm'>,
): boolean {
  if (!hasGps(asset)) return false;
  const { country } = home.of(asset);
  const distance = home.distanceFromHome(asset);
  const far = distance !== null && distance > params.minDistanceKm;
  // GPS without a country (sea, remote areas) or no home country: decide by distance.
  const otherCountry =
    asset.country !== null && country !== null
      ? asset.country !== country
      : far;
  switch (params.awayRule) {
    case 'other-country':
      return otherCountry;
    case 'distance':
      return far;
    case 'either':
      return otherCountry || far;
  }
}
