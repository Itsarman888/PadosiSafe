// Place search and reverse geocoding via OpenStreetMap Nominatim (free, no key, India only).
// Usage policy: light interactive use only. Swap for your own geocoder if you expect traffic.
import { shortPlaceName } from './util.mjs';

const NOMINATIM = 'https://nominatim.openstreetmap.org';

export async function searchPlaces(query, signal) {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', countrycodes: 'in', limit: '5', 'accept-language': 'en' });
  const res = await fetch(`${NOMINATIM}/search?${params}`, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Search failed');
  const rows = await res.json();
  return rows
    .map((r) => ({ lat: Number(r.lat), lng: Number(r.lon), label: shortPlaceName(r.display_name) }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

export async function reverseGeocode(lat, lng, signal) {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lng), format: 'jsonv2', zoom: '16', 'accept-language': 'en' });
  const res = await fetch(`${NOMINATIM}/reverse?${params}`, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const row = await res.json();
  return row && row.display_name ? shortPlaceName(row.display_name) : null;
}
