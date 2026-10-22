// Minimal stand-in for the parts of Leaflet 1.9 that PadosiSafe uses. Records what the app does.
(function () {
  const rec = (window.__L = { map: null, layers: [], markers: [], circle: null, calls: [] });
  const log = (...a) => rec.calls.push(a.join(' '));
  class Evented { constructor() { this._h = {}; } on(t, f) { (this._h[t] = this._h[t] || []).push(f); return this; } fire(t, e) { (this._h[t] || []).forEach((f) => f(e)); } }
  class Layer extends Evented { addTo(t) { t.addLayer ? t.addLayer(this) : t._add(this); return this; } }
  class Group extends Layer {
    constructor() { super(); this.items = []; this.onMap = false; }
    addLayer(l) { this.items.push(l); return this; }
    clearLayers() { this.items = []; return this; }
    _add(map) { this.onMap = true; map._layers.add(this); }
  }
  class Marker extends Layer {
    constructor(ll, o) { super(); this.ll = { lat: ll[0], lng: ll[1] }; this.o = o || {}; this.popup = null; this.open = false; rec.markers.push(this); }
    _add(map) { this.onMap = true; map._layers.add(this); }
    setLatLng(ll) { this.ll = { lat: ll[0], lng: ll[1] }; return this; }
    getLatLng() { return this.ll; }
    bindPopup(c, o) { this.popup = c; return this; }
    openPopup() { this.open = true; return this; }
  }
  class Circle extends Layer {
    constructor(ll, o) { super(); this.ll = { lat: ll[0], lng: ll[1] }; this.o = o; rec.circle = this; }
    _add(map) { map._layers.add(this); }
    setLatLng(ll) { this.ll = { lat: ll[0], lng: ll[1] }; return this; }
  }
  class MapC extends Evented {
    constructor(el, o) { super(); this.el = el; this.o = o; this._layers = new Set(); this._zoom = 5; rec.map = this; }
    fitBounds(b) { log('fitBounds'); return this; }
    flyTo(ll, z) { log('flyTo', ll[0], ll[1], z); this._zoom = z; return this; }
    getZoom() { return this._zoom; }
    invalidateSize() { return this; }
    hasLayer(l) { return this._layers.has(l); }
    removeLayer(l) { this._layers.delete(l); if ('onMap' in l) l.onMap = false; return this; }
    addLayer(l) { this._layers.add(l); if ('onMap' in l) l.onMap = true; return this; }
  }
  const tile = () => ({ addTo(m) { return this; } });
  window.L = {
    map: (el, o) => new MapC(el, o),
    tileLayer: tile,
    control: { zoom: () => ({ addTo() {} }), layers: () => ({ addTo() {} }) },
    layerGroup: () => { const g = new Group(); rec.layers.push(g); return g; },
    divIcon: (o) => o,
    marker: (ll, o) => new Marker(ll, o),
    circle: (ll, o) => new Circle(ll, o),
  };
})();
