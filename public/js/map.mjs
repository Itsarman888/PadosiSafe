// Leaflet + OpenStreetMap wrapper. Leaflet is loaded from a CDN at runtime; if it cannot load,
// createMap() returns a no-op map so the rest of the app (search, city chips, GPS, lists) still works.
import { CATEGORY_META, PLACE_META, SEVERITY_META, formatDistance, timeAgo } from './util.mjs';
import { h } from './dom.mjs';

const SOURCES = [
  { js: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js', css: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css' },
  { js: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', css: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css' },
];

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

function loadCss(href) {
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = resolve;
    link.onerror = resolve; // missing CSS should not block the app
    document.head.appendChild(link);
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

export async function loadLeaflet() {
  if (window.L) return window.L;
  for (const src of SOURCES) {
    try {
      await withTimeout(Promise.all([loadCss(src.css), loadScript(src.js)]), 9000);
      if (window.L) return window.L;
    } catch {
      /* try the next CDN */
    }
  }
  return null;
}

const noop = () => {};
export function unavailableMap() {
  return {
    available: false,
    setPin: noop, clearPin: noop, flyTo: noop, setRadius: noop,
    setAlerts: noop, setPlaces: noop, setSOS: noop, setLayers: noop, openAlert: noop, openPlace: noop,
  };
}

export async function createMap(el, { bounds, onPick, getNow = Date.now }) {
  const L = await loadLeaflet();
  if (!L) return unavailableMap();

  const map = L.map(el, {
    zoomControl: false,
    minZoom: 4,
    maxBounds: [[bounds.south - 4, bounds.west - 6], [bounds.north + 4, bounds.east + 8]],
    maxBoundsViscosity: 0.85,
    worldCopyJump: false,
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.fitBounds([[8.0, 68.5], [35.5, 97.0]], { padding: [6, 6] });

  const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const humanitarian = L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
    maxZoom: 19,
    subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Tiles by <a href="https://www.hotosm.org/">HOT</a>',
  });
  street.addTo(map);
  L.control.layers({ 'Street map': street, 'Humanitarian map': humanitarian }, null, { position: 'topright' }).addTo(map);

  const groups = { alerts: L.layerGroup(), places: L.layerGroup(), sos: L.layerGroup() };
  const alertMarkers = new Map();
  const placeMarkers = new Map();
  let pinMarker = null;
  let radiusCircle = null;

  map.on('click', (e) => onPick(e.latlng.lat, e.latlng.lng));

  new ResizeObserver(() => map.invalidateSize()).observe(el);

  const pinIcon = L.divIcon({ className: '', html: '<span class="pin"></span>', iconSize: [30, 38], iconAnchor: [15, 36] });

  function popupFor(title, lines, actionLabel, onAction) {
    return h('div', { class: 'popup' },
      h('strong', {}, title),
      ...lines.filter(Boolean).map((l) => h('p', {}, l)),
      actionLabel ? h('button', { class: 'btn btn-small', onClick: onAction }, actionLabel) : null);
  }

  return {
    available: true,

    setPin(lat, lng) {
      if (!pinMarker) {
        pinMarker = L.marker([lat, lng], { draggable: true, icon: pinIcon, zIndexOffset: 1000, title: 'Your pin. Drag to move it.', keyboard: false }).addTo(map);
        pinMarker.on('dragend', () => {
          const p = pinMarker.getLatLng();
          onPick(p.lat, p.lng);
        });
      } else {
        pinMarker.setLatLng([lat, lng]);
      }
      if (radiusCircle) radiusCircle.setLatLng([lat, lng]);
    },

    clearPin() {
      if (pinMarker) { map.removeLayer(pinMarker); pinMarker = null; }
      if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
    },

    flyTo(lat, lng, zoom = 14) {
      map.flyTo([lat, lng], zoom, { duration: 0.8 });
    },

    setRadius(km, lat, lng) {
      if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
      if (!km || lat === undefined) return;
      radiusCircle = L.circle([lat, lng], { radius: km * 1000, color: '#1d2240', weight: 1.5, dashArray: '5 5', fillColor: '#1d2240', fillOpacity: 0.05, interactive: false }).addTo(map);
    },

    setAlerts(alerts, onOpen) {
      groups.alerts.clearLayers();
      alertMarkers.clear();
      for (const a of alerts) {
        const cat = CATEGORY_META[a.category] || CATEGORY_META.other;
        const sev = SEVERITY_META[a.severity] ? a.severity : 'info';
        const icon = L.divIcon({ className: '', html: `<span class="mk mk-alert sev-${sev}">${cat.emoji}</span>`, iconSize: [38, 38], iconAnchor: [19, 19], popupAnchor: [0, -18] });
        const marker = L.marker([a.lat, a.lng], { icon, title: `${SEVERITY_META[sev].label}: ${a.summary}`, riseOnHover: true });
        marker.bindPopup(popupFor(a.summary, [`${cat.label}, ${timeAgo(getNow() - a.createdAt)}`, a.distanceKm !== null ? `${formatDistance(a.distanceKm)} from your pin` : ''], 'See details', () => onOpen(a.id)), { maxWidth: 240 });
        marker.addTo(groups.alerts);
        alertMarkers.set(a.id, marker);
      }
    },

    setPlaces(places, onOpen) {
      groups.places.clearLayers();
      placeMarkers.clear();
      for (const p of places) {
        const meta = PLACE_META[p.type] || PLACE_META.shelter;
        const icon = L.divIcon({ className: '', html: `<span class="mk mk-place">${meta.emoji}</span>`, iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -14] });
        const marker = L.marker([p.lat, p.lng], { icon, title: `${meta.label}: ${p.name}`, riseOnHover: true });
        marker.bindPopup(popupFor(p.name, [meta.label, p.note, p.distanceKm !== null ? `${formatDistance(p.distanceKm)} from your pin` : ''], 'See details', () => onOpen(p.id)), { maxWidth: 240 });
        marker.addTo(groups.places);
        placeMarkers.set(p.id, marker);
      }
    },

    setSOS(members, onOpen) {
      groups.sos.clearLayers();
      for (const m of members) {
        const icon = L.divIcon({ className: '', html: '<span class="mk mk-sos">SOS</span>', iconSize: [44, 44], iconAnchor: [22, 22], popupAnchor: [0, -20] });
        L.marker([m.sos.lat, m.sos.lng], { icon, title: `${m.name} sent an SOS` })
          .bindPopup(popupFor(`${m.name} sent an SOS`, [m.sos.note], 'Open circle', onOpen), { maxWidth: 240 })
          .addTo(groups.sos);
      }
    },

    /** Show only the marker groups that matter for the current tab. */
    setLayers({ alerts = false, places = false, sos = false }) {
      const want = { alerts, places, sos };
      for (const [name, group] of Object.entries(groups)) {
        if (want[name] && !map.hasLayer(group)) group.addTo(map);
        if (!want[name] && map.hasLayer(group)) map.removeLayer(group);
      }
    },

    openAlert(id) {
      const m = alertMarkers.get(id);
      if (m) { map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 14), { duration: 0.6 }); m.openPopup(); }
    },

    openPlace(id) {
      const m = placeMarkers.get(id);
      if (m) { map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.6 }); m.openPopup(); }
    },
  };
}
