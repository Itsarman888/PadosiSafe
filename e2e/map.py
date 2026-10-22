import sys
import os
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
from playwright.sync_api import sync_playwright

BASE = os.environ.get("E2E_BASE", "http://localhost:3000")
STUB = open(os.path.join(HERE, "leaflet-stub.js")).read()
problems = []

def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: problems.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 800}, bypass_csp=True)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    ctx.route("**/leaflet@1.9.4/dist/leaflet.js", lambda r: r.fulfill(body=STUB, content_type="text/javascript"))
    ctx.route("**/leaflet@1.9.4/dist/leaflet.css", lambda r: r.fulfill(body="", content_type="text/css"))
    page.goto(BASE)
    page.wait_for_selector("body[data-ready=true]")
    page.wait_for_function("document.body.dataset.map === 'ready'", timeout=15000)
    check(True, "app swaps in the (stub) map once it loads")
    check(page.locator("#map").is_visible() and not page.locator(".mapwrap.no-map").count(), "map container visible, no fallback")

    L = lambda expr: page.evaluate(f"(() => {{ const L = window.__L; return {expr}; }})()")
    check(L("L.calls.includes('fitBounds')"), "map fitted to India on start")
    check(L("L.map.o.maxBounds[0][0] < 6 && L.map.o.maxBounds[1][1] > 98"), "map panning limited to around India")

    # tap Mumbai -> pin
    page.evaluate("window.__L.map.fire('click', {latlng: {lat: 19.076, lng: 72.8777}})")
    page.wait_for_function("document.querySelector('#pinStatus').textContent.includes('19.0760')")
    check(L("L.markers.some(m => m.o.draggable && Math.abs(m.ll.lat - 19.076) < 1e-6)"), "tapping the map drops a draggable pin")
    check(not page.locator("#radiusSelect").is_disabled(), "radius control enabled after pin")

    # tap London -> rejected, pin unchanged
    page.evaluate("window.__L.map.fire('click', {latlng: {lat: 51.5, lng: -0.12}})")
    page.wait_for_selector("#toast:has-text('outside India')")
    check("19.0760" in page.inner_text("#pinStatus"), "pin outside India rejected, old pin kept")

    # drag pin (dragend handler) to Delhi
    page.evaluate("""(() => { const m = window.__L.markers.find(x => x.o.draggable); m.ll = {lat: 28.6139, lng: 77.209}; m.fire('dragend'); })()""")
    page.wait_for_function("document.querySelector('#pinStatus').textContent.includes('28.6139')")
    check(True, "dragging the pin updates location")

    # layers per tab
    group_state = lambda: page.evaluate("window.__L.layers.map(g => [g.onMap, g.items.length])")
    print("circle tab groups:", group_state())
    check(L("L.layers.filter(g => g.onMap).length") == 1, "circle tab: only the SOS layer is on the map")
    page.get_by_role("tab", name="Alerts").click()
    page.wait_for_selector("#alertList .item")
    page.wait_for_timeout(300)
    gs = group_state()
    print("alerts tab groups:", gs)
    check(L("L.layers.filter(g => g.onMap).length") == 1 and any(on and n >= 6 for on, n in gs), "alerts tab: all alert markers on the map")
    sev = page.evaluate("window.__L.markers.filter(m => m.o.title && m.o.title.startsWith('Urgent')).length")
    check(sev >= 1, "urgent alert marker carries an accessible title")
    # 'Show on map' opens the popup and flies there
    page.locator("#alertList .item").first.get_by_role("button", name="Show on map").click()
    check(L("L.markers.some(m => m.open)") and L("L.calls.some(c => c.startsWith('flyTo'))"), "Show on map flies to and opens the marker popup")
    # popup element is DOM (safe: text nodes only)
    check(page.evaluate("window.__L.markers.filter(m => m.popup && m.popup instanceof HTMLElement).length >= 6"), "popups are DOM nodes (no innerHTML)")

    page.get_by_role("tab", name="Resources").click()
    page.wait_for_selector("#placeList .item")
    page.wait_for_timeout(300)
    gs = group_state()
    print("resources tab groups:", gs)
    check(any(on and n >= 14 for on, n in gs) and L("L.layers.filter(g => g.onMap).length") == 1, "resources tab: place markers shown, alert markers hidden")

    # radius circle
    page.select_option("#radiusSelect", "10")
    page.wait_for_timeout(300)
    check(L("L.circle && L.circle.o.radius === 10000"), "radius circle drawn at 10 km")
    page.select_option("#radiusSelect", "")

    # SOS marker on circle tab
    page.get_by_role("tab", name="My circle").click()
    page.get_by_role("button", name="Open the demo circle").click()
    page.wait_for_selector("#cMembers .member")
    page.get_by_role("button", name="Send SOS to my circle").click()
    page.fill("#sosNote", "Test SOS")
    page.get_by_role("button", name="Send SOS now").click()
    page.wait_for_selector("text=SOS sent")
    page.wait_for_timeout(300)
    check(L("L.markers.some(m => m.o.title && m.o.title.includes('sent an SOS'))"), "SOS shown on the map using the pinned location")
    check("sos" in page.inner_text("#cMembers .member:has-text('(you)')").lower(), "my SOS visible in the list")
    check(page.get_by_role("link", name="Open in OpenStreetMap").count() >= 1, "SOS has an OpenStreetMap link")

    print("page errors:", errs)
    check(not errs, "no JS errors with the map active")
    page.screenshot(path=os.path.join(OUT, "shot-map-stub.png"))
    b.close()

print("\nFAILED:" if problems else "\nALL PASSED", problems)
sys.exit(1 if problems else 0)
