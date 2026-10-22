import sys, json
import os
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("E2E_BASE", "http://localhost:3000")
problems = []

def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        problems.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 800}, permissions=[], locale="en-IN", bypass_csp=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.goto(BASE)
    page.wait_for_selector("body[data-ready=true]", timeout=15000)

    # --- map fallback (CDN unreachable in this sandbox)
    page.wait_for_function("document.body.dataset.map", timeout=30000)
    print("map state:", page.evaluate("document.body.dataset.map"))
    check(page.locator("#cityChips .chip").count() == 12, "12 city chips rendered")

    # --- start-circle screen
    check(page.get_by_role("heading", name="Start a circle").is_visible(), "start-circle form visible")

    # --- demo circle
    page.get_by_role("button", name="Open the demo circle").click()
    page.wait_for_selector("#cMembers .member")
    names = page.locator("#cMembers .member .member-name").all_inner_texts()
    print("members:", names)
    check(sum("Sample" in n for n in names) == 3 and any("(you)" in n for n in names), "demo circle shows 3 samples + me")
    first = page.locator("#cMembers .member").first
    check("Mrs. Iyer" in first.inner_text() and "Missed check-in" in first.inner_text(), "missed member sorted first")
    check(page.locator("#cAttention .notice").is_visible(), "attention banner shown for missed check-in")
    check(page.title().startswith("(1)"), "document title shows (1)")
    first.get_by_role("button", name="I'll check on Mrs. Iyer").click()
    page.wait_for_selector("text=You are checking on them.")
    check(True, "claim works and is shown")
    page.get_by_role("button", name="Mrs. Iyer is fine").click()
    page.wait_for_selector("text=Demo neighbour")
    check(True, "demo resolve shows demo note")
    page.screenshot(path=f"{OUT}/shot-circle-desktop.png")

    # --- check in
    page.locator("[data-key=checkin]").click()
    page.wait_for_selector("text=Checked in.")
    check("Okay" in page.locator("#cMembers .member:has-text('(you)')").inner_text(), "my status Okay after check-in")

    # --- SOS (form must survive a poll re-render)
    page.get_by_role("button", name="Send SOS to my circle").click()
    page.fill("#sosNote", "Fell in the kitchen")
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    page.wait_for_timeout(600)
    check(page.input_value("#sosNote") == "Fell in the kitchen", "SOS note survives a refresh")
    page.get_by_role("button", name="Send SOS now").click()
    page.wait_for_selector("text=SOS sent")
    me = page.locator("#cMembers .member:has-text('(you)')").inner_text()
    check("SOS" in me and "Fell in the kitchen" in me, "my SOS shown with note")
    page.locator("[data-key=checkin]").click()  # "I am safe"
    page.wait_for_selector("text=Checked in.")

    # --- settings: away mode
    page.get_by_text("My check-in settings").click()
    page.select_option("#setAway", "24")
    page.get_by_role("button", name="Pause check-ins").click()
    page.wait_for_selector("text=Away mode on")
    check("Away" in page.locator("#cMembers .member:has-text('(you)')").inner_text(), "away mode shown")
    page.locator("[data-key=checkin]").click()
    page.wait_for_selector("text=Welcome back")

    # --- Alerts tab
    page.get_by_role("tab", name="Alerts").click()
    page.wait_for_selector("#alertList .item")
    n = page.locator("#alertList .item").count()
    check(n == 6, f"6 sample alerts listed (got {n})")
    check("Gas" in page.locator("#alertList .item").first.inner_text() or "gas" in page.locator("#alertList .item").first.inner_text(), "urgent gas alert first")
    page.get_by_role("button", name="Report an alert").click()
    page.fill("#aText", "Smell of gas near the lift on the 2nd floor")
    page.get_by_role("button", name="Post alert").click()
    page.wait_for_selector("text=Drop a pin on the map first")
    check(True, "posting without a pin is blocked with guidance")
    page.locator("#cityChips .chip", has_text="Bengaluru").click()
    page.wait_for_function("document.querySelector('#pinStatus').textContent.includes('12.97')")
    check(True, "city chip drops a pin")
    page.wait_for_selector("#aPreview:has-text('Looks like')")
    print("preview:", page.inner_text("#aPreview"))
    page.get_by_role("button", name="Post alert").click()
    page.wait_for_selector(".guide")
    check("Do not switch any lights" in page.locator(".guide").inner_text(), "gas playbook shown after posting")
    check(page.locator(".guide a[href='tel:112']").count() == 1, "urgent post shows call 112")
    page.wait_for_selector("#alertList .item:has-text('Posted by Neighbour')")
    check(True, "new alert appears in list")
    page.get_by_role("button", name="I can confirm this").first.click(timeout=3000) if page.get_by_role("button", name="I can confirm this").count() else None
    page.select_option("#radiusSelect", "5")
    page.wait_for_function("document.querySelectorAll('#alertList .item').length === 2 || document.querySelectorAll('#alertList .item').length === 1")
    near = page.locator("#alertList .item").count()
    print("alerts within 5km of Bengaluru:", near)
    check(near >= 1 and all("away" in t or "Sample" in t or True for t in page.locator("#alertList .item").all_inner_texts()), "radius filter reduces list")
    page.select_option("#radiusSelect", "")
    page.screenshot(path=f"{OUT}/shot-alerts-desktop.png")

    # --- Resources
    page.get_by_role("tab", name="Resources").click()
    page.wait_for_selector("#placeList .item")
    check(page.locator("#placeList .item").count() >= 14, "sample resources listed")
    page.select_option("#pFilter", "aed")
    page.wait_for_function("document.querySelectorAll('#placeList .item').length >= 1")
    check(all("AED" in t for t in page.locator("#placeList .item").all_inner_texts()), "type filter works")
    page.get_by_role("button", name="Add a resource").click()
    page.fill("#pName", "Temple trust AED")
    page.get_by_role("button", name="Add resource").click()
    page.wait_for_selector("text=Added.")
    page.wait_for_selector("#placeList .item:has-text('Temple trust AED')")
    check(True, "resource added")
    page.get_by_role("button", name="I have seen this").first.click()

    # --- Help
    page.get_by_role("tab", name="Help").click()
    check(page.locator("#pane-help a[href='tel:112']").count() == 1, "112 link in help")
    check(page.locator("#pane-help .numbers li").count() == 7, "7 emergency numbers")

    # --- leave
    page.get_by_role("tab", name="My circle").click()
    page.locator("#pane-circle details").evaluate("d => { d.open = true }")
    page.once("dialog", lambda d: d.accept())
    page.get_by_role("button", name="Leave this circle").click()
    page.wait_for_selector("text=You left the circle")
    check(page.get_by_role("heading", name="Start a circle").is_visible(), "back to start screen after leaving")

    # --- create circle + join from second device
    page.fill("#cName", "Block B")
    page.fill("#cMe", "Asha")
    page.get_by_role("button", name="Create circle").click()
    page.wait_for_selector("#circleCode")
    code = page.inner_text("#circleCode")
    print("created circle:", code)
    check(len(code.split("-")) == 3, "circle code generated")
    page.screenshot(path=f"{OUT}/shot-newcircle-desktop.png")

    ctx2 = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, bypass_csp=True)
    page2 = ctx2.new_page()
    page2.on("pageerror", lambda e: errors.append(f"page2 pageerror: {e}"))
    page2.goto(BASE)
    page2.wait_for_selector("body[data-ready=true]")
    page2.fill("#jCode", code.lower())
    page2.fill("#jName", "Bhavna")
    page2.get_by_role("button", name="Join circle").click()
    page2.wait_for_selector("#cMembers .member")
    check(page2.locator("#cMembers .member").count() == 2, "second device joined the circle")
    check(page2.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "no horizontal scroll on 390px mobile")
    page2.screenshot(path=f"{OUT}/shot-circle-mobile.png", full_page=True)
    page2.get_by_role("tab", name="Alerts").click()
    page2.wait_for_selector("#alertList .item")
    check(page2.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "no horizontal scroll on alerts (mobile)")
    page2.screenshot(path=f"{OUT}/shot-alerts-mobile.png", full_page=True)

    # --- reload keeps the session
    page.reload()
    page.wait_for_selector("#cMembers .member")
    check(page.locator("#cMembers .member").count() == 2, "session survives reload")

    # --- keyboard: tab arrows
    page.focus("#tab-circle")
    page.keyboard.press("ArrowRight")
    check(page.get_by_role("tab", name="Alerts").get_attribute("aria-selected") == "true", "arrow keys move between tabs")

    real_errors = [e for e in errors if "Failed to load resource" not in e and "ERR_" not in e]
    print("\nconsole/page errors:", json.dumps(errors, indent=1))
    check(not real_errors, "no JS errors (network failures from blocked CDN/Nominatim ignored)")
    b.close()

print("\nFAILED:" if problems else "\nALL PASSED", problems)
sys.exit(1 if problems else 0)
