// Pure helpers and display metadata (no DOM access, so they can be unit tested in Node).

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const CATEGORY_META = {
  fire: { emoji: '🔥', label: 'Fire' },
  gas: { emoji: '💨', label: 'Gas leak' },
  flood: { emoji: '🌊', label: 'Flooding' },
  power: { emoji: '⚡', label: 'Power cut' },
  medical: { emoji: '🩺', label: 'Medical' },
  crime: { emoji: '🚨', label: 'Crime or safety' },
  accident: { emoji: '🚧', label: 'Accident or road' },
  weather: { emoji: '🌪️', label: 'Storm or weather' },
  water: { emoji: '💧', label: 'Water supply' },
  other: { emoji: '📣', label: 'Something else' },
};

export const SEVERITY_META = {
  urgent: { label: 'Urgent', icon: '⚠', hint: 'Someone may be in danger right now' },
  watch: { label: 'Be careful', icon: '◆', hint: 'A hazard to avoid or keep an eye on' },
  info: { label: 'FYI', icon: 'ℹ', hint: 'An inconvenience, not a danger' },
};

export const PLACE_META = {
  first_aid: { emoji: '🩹', label: 'First-aid kit' },
  extinguisher: { emoji: '🧯', label: 'Fire extinguisher' },
  aed: { emoji: '🫀', label: 'AED (defibrillator)' },
  first_aider: { emoji: '🧑‍⚕️', label: 'Trained first-aider' },
  hospital: { emoji: '🏥', label: 'Hospital or clinic' },
  pharmacy: { emoji: '💊', label: 'Pharmacy' },
  shelter: { emoji: '🏠', label: 'Shelter' },
  police: { emoji: '🚓', label: 'Police' },
  fire_station: { emoji: '🚒', label: 'Fire station' },
  water: { emoji: '🚰', label: 'Drinking water' },
};

export const CITIES = [
  { name: 'Delhi', lat: 28.6139, lng: 77.209 },
  { name: 'Mumbai', lat: 19.076, lng: 72.8777 },
  { name: 'Bengaluru', lat: 12.9716, lng: 77.5946 },
  { name: 'Chennai', lat: 13.0827, lng: 80.2707 },
  { name: 'Kolkata', lat: 22.5726, lng: 88.3639 },
  { name: 'Hyderabad', lat: 17.385, lng: 78.4867 },
  { name: 'Pune', lat: 18.5204, lng: 73.8567 },
  { name: 'Ahmedabad', lat: 23.0225, lng: 72.5714 },
  { name: 'Jaipur', lat: 26.9124, lng: 75.7873 },
  { name: 'Lucknow', lat: 26.8467, lng: 80.9462 },
  { name: 'Kochi', lat: 9.9312, lng: 76.2673 },
  { name: 'Guwahati', lat: 26.1445, lng: 91.7362 },
];

// Used if /api/config cannot be reached, so emergency numbers still work offline.
export const FALLBACK_CONFIG = {
  bounds: { south: 6.0, north: 37.8, west: 67.9, east: 98.0 },
  intervalHours: [6, 12, 24, 48],
  graceMinutes: [30, 60, 120, 240],
  awayHours: [6, 24, 72, 168],
  demoCode: 'DEMO-2026',
  persistent: true,
  playbooks: {},
  categories: Object.keys(CATEGORY_META),
  placeTypes: Object.keys(PLACE_META),
  emergencyNumbers: [
    { number: '112', label: 'National emergency number (police, fire, ambulance)' },
    { number: '100', label: 'Police' },
    { number: '101', label: 'Fire brigade' },
    { number: '108', label: 'Emergency ambulance (varies by state)' },
    { number: '1091', label: 'Women helpline' },
    { number: '1098', label: 'Childline' },
    { number: '1906', label: 'LPG gas leak helpline' },
  ],
};

export function timeAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.floor(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / MIN));
  if (total < 1) return 'under a minute';
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  const days = `${d} day${d === 1 ? '' : 's'}`;
  return rh ? `${days} ${rh} h` : days;
}

export function formatDistance(km) {
  if (km === null || km === undefined || !Number.isFinite(km)) return '';
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

export function shortPlaceName(displayName) {
  return String(displayName || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
}

export function inBounds(lat, lng, b) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
}

export function round5(n) {
  return Math.round(n * 1e5) / 1e5;
}

export function osmLink(lat, lng) {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Everything the UI needs to describe a member's state in words (never colour alone). */
export function memberStatusView(s, now) {
  switch (s.state) {
    case 'ok':
      return { tone: 'ok', icon: '✓', label: 'Okay', detail: `Checked in ${timeAgo(now - s.lastCheckIn)}` };
    case 'due':
      return { tone: 'due', icon: '◔', label: 'Check-in due', detail: `Overdue by ${formatDuration(now - s.dueAt)}` };
    case 'missed':
      return { tone: 'missed', icon: '!', label: 'Missed check-in', detail: `Last seen ${timeAgo(now - s.lastCheckIn)}` };
    case 'sos':
      return { tone: 'sos', icon: 'SOS', label: 'SOS', detail: `Sent ${timeAgo(now - s.since)}` };
    case 'away':
      return { tone: 'away', icon: '☾', label: 'Away', detail: `Back in ${formatDuration(s.until - now)}` };
    default:
      return { tone: 'ok', icon: '', label: '', detail: '' };
  }
}

export function intervalLabel(hours) {
  return hours % 24 === 0 ? `${hours / 24 === 1 ? 'day' : `${hours / 24} days`}` : `${hours} hours`;
}

export function graceLabel(minutes) {
  return minutes >= 60 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`;
}

export function awayLabel(hours) {
  if (hours < 24) return `${hours} hours`;
  const d = hours / 24;
  return d === 7 ? '1 week' : `${d} day${d === 1 ? '' : 's'}`;
}
