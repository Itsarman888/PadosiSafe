'use strict';

/**
 * Sample data so the app is not empty on first open. Everything here is flagged `demo`
 * and shown as "Sample" in the UI. Locations are approximate neighbourhood centres, and the
 * resources are generic examples rather than real facilities.
 *
 * Demo alerts keep a fixed age (ageMin) relative to "now" so they never look stale.
 * The demo circle's members are simulated (their last check-in is computed from the clock)
 * so every visitor sees one member OK, one nudged, and one who has missed a check-in.
 */

const { DEMO_CODE } = require('./logic');

const SEED_KEY = 'seeded:v1';

const alert = (n, category, severity, ageMin, lat, lng, text, summary, confirms) => ({
  id: `a_demo${n}`,
  text,
  summary,
  category,
  severity,
  lat,
  lng,
  name: 'Sample',
  demo: true,
  ageMin,
  createdAt: 0,
  authorHash: null,
  confirms: Array.from({ length: confirms }, (_, i) => `seed-${n}-${i}`),
  resolveVotes: [],
  resolved: false,
});

const SEED_ALERTS = [
  alert(1, 'flood', 'watch', 25, 19.119, 72.848,
    'Waterlogging near the subway, knee-deep. Two-wheelers are stuck. Avoid the underpass.',
    'Waterlogging near the subway, knee-deep', 4),
  alert(2, 'gas', 'urgent', 8, 28.5677, 77.2433,
    'Strong smell of gas from a building basement. Residents are evacuating and keeping lights off.',
    'Strong smell of gas from a building basement', 3),
  alert(3, 'power', 'watch', 95, 12.9352, 77.6245,
    'Power cut for 3 hours across the lane. The transformer was sparking earlier, so keep away from it.',
    'Power cut for 3 hours across the lane', 5),
  alert(4, 'weather', 'watch', 40, 13.0418, 80.2341,
    'Tree fallen across the road and blocking the lane. Ambulance access is affected.',
    'Tree fallen across the road, lane blocked', 2),
  alert(5, 'water', 'info', 150, 22.5867, 88.4171,
    'Drinking water has been muddy since the evening. Boil it before use.',
    'Drinking water muddy since evening', 6),
  alert(6, 'medical', 'watch', 12, 17.4126, 78.4482,
    'Elderly neighbour fell near the park gate. Conscious but cannot stand. Ambulance already called.',
    'Elderly neighbour fell near the park gate', 1),
];

const place = (n, type, name, note, lat, lng, verifies) => ({
  id: `p_demo${n}`,
  type,
  name,
  note,
  lat,
  lng,
  addedBy: 'Sample',
  createdAt: 0,
  demo: true,
  verifies: Array.from({ length: verifies }, (_, i) => `seed-p${n}-${i}`),
});

const SEED_PLACES = [
  place(1, 'first_aid', 'Society office first-aid kit', 'Ask the security desk. Kit is restocked monthly.', 19.1205, 72.8465, 3),
  place(2, 'shelter', 'Community hall (flood shelter)', 'Upper floor stays dry. Seats about 80 people.', 19.1172, 72.8501, 2),
  place(3, 'extinguisher', 'Lobby fire extinguisher', 'ABC powder type, next to the lift.', 28.5691, 77.2418, 2),
  place(4, 'pharmacy', '24x7 chemist', 'Open all night. Delivers within 2 km.', 28.5655, 77.2451, 4),
  place(5, 'aed', 'Clubhouse AED', 'Wall cabinet beside the reception desk.', 12.9366, 77.6231, 1),
  place(6, 'water', 'Public drinking-water point', 'Filtered water, free for everyone.', 12.9331, 77.6262, 2),
  place(7, 'shelter', 'School hall (cyclone shelter)', 'Opened by the ward office during alerts.', 13.0433, 80.2362, 2),
  place(8, 'police', 'Police outpost', 'Staffed round the clock.', 13.0401, 80.2318, 3),
  place(9, 'first_aid', 'Para club first-aid box', 'Kept in the club room. Ask any committee member.', 22.5851, 88.4143, 1),
  place(10, 'hospital', 'Government hospital (casualty)', 'Casualty ward is open 24 hours.', 17.4098, 78.4511, 5),
  place(11, 'first_aider', 'CPR-trained volunteer', 'Retired nurse in Block C who is happy to help in emergencies.', 17.4143, 78.4465, 1),
  place(12, 'extinguisher', 'Apartment block extinguisher', 'One on every floor landing.', 18.5086, 73.8059, 2),
  place(13, 'fire_station', 'Fire station', 'Nearest engine is about 3 km away.', 23.0412, 72.5631, 3),
  place(14, 'first_aider', 'Trained first-aider', 'Volunteer with a St John first-aid certificate.', 26.8559, 75.8203, 1),
];

const DEMO_CIRCLE_NAME = 'Lotus Heights (demo circle)';

function buildDemoCircle(now) {
  const member = (id, name, intervalHours, graceMinutes, agoMin) => ({
    id,
    name,
    tokenHash: null,
    joinedAt: now,
    lastCheckIn: now,
    intervalHours,
    graceMinutes,
    pausedUntil: null,
    sos: null,
    claim: null,
    simulated: { agoMin },
  });
  return {
    code: DEMO_CODE,
    name: DEMO_CIRCLE_NAME,
    area: 'Sample housing society',
    lat: 19.076,
    lng: 72.8777,
    createdAt: now,
    members: [
      member('m_demo1', 'Asha', 24, 60, 120), // checked in 2 hours ago -> ok
      member('m_demo2', 'Raju Uncle', 12, 60, 12 * 60 + 25), // 25 min past due -> due
      member('m_demo3', 'Mrs. Iyer', 24, 60, 24 * 60 + 150), // 2.5 h past due -> missed
    ],
    events: [{ id: 'e_demo1', at: now, type: 'join', text: 'Demo circle created with three sample neighbours' }],
  };
}

/** Idempotent. Call it outside store.tx() (it uses tx itself). */
async function ensureSeed(store, now = Date.now()) {
  if (await store.get(SEED_KEY)) return;
  await store.tx(async () => {
    if (await store.get(SEED_KEY)) return;
    const alerts = (await store.get('alerts')) || [];
    const places = (await store.get('places')) || [];
    await store.set('alerts', [...SEED_ALERTS, ...alerts]);
    await store.set('places', [...SEED_PLACES, ...places]);
    if (!(await store.get(`circle:${DEMO_CODE}`))) {
      await store.set(`circle:${DEMO_CODE}`, buildDemoCircle(now));
    }
    await store.set(SEED_KEY, true);
  });
}

module.exports = { ensureSeed, SEED_ALERTS, SEED_PLACES, buildDemoCircle };
