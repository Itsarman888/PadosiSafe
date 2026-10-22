# PadosiSafe: Devpost submission text

Copy each section into the matching Devpost field. Replace the bracketed placeholders.

**Track:** Safety & Emergency Response
**Tagline (60 chars max):** Neighbours looking out for neighbours, anywhere in India

---

## Inspiration

Most emergencies in a neighbourhood are noticed by neighbours first: the elderly person living alone who has not opened their door in two days, the gas smell in a stairwell, the underpass that floods every monsoon. But there is no quick, private way to notice and coordinate. WhatsApp groups bury the signal, and most apps want accounts, emails and phone numbers that older people (the ones who need this most) simply will not give.

I wanted to see how little it takes: no sign-up, no email, one tap.

## What it does

PadosiSafe is a neighbour check-in circle plus a hyperlocal safety board, built around a map of India.

- **Check-in circles.** A few neighbours join with a short code (like `NEEM-LOTUS-4821`) and a first name. Each person taps "I'm okay" on their own schedule. If someone misses it, they rise to the top of everyone's list, and one neighbour taps "I'll check on them" so nobody is double-called and nobody is left alone.
- **SOS and away mode.** One tap sends an SOS (with a note and location, if allowed) to the circle. It says plainly that it does not call emergency services and puts "Call 112" first. Away mode pauses check-ins when someone travels.
- **Alert board.** Anyone can report a hazard by dropping a pin. A triage step picks the type and urgency (it understands English, Hinglish and Devanagari keywords). Neighbours confirm it, it expires on its own, and two neighbours can close it.
- **"What to do now".** Each alert type has a short, vetted playbook (gas leak, fire, flood, power cut...). The classifier only categorises, and the safety advice is never generated.
- **Resource map.** Neighbours add and verify first-aid kits, extinguishers, AEDs, shelters and trained first-aiders.
- **India map.** Search any place, jump to a city, use GPS, or tap and drag a pin. Everything sorts by distance, with a radius filter, and pins outside India are rejected.

## How I built it

A zero-dependency Node 22 backend (a small serverless-friendly HTTP layer) and a plain JavaScript frontend with Leaflet and OpenStreetMap. The whole thing deploys to Vercel as a static site plus one function, with no build step.

Two decisions shaped it:

1. **Check-in status is computed from the clock**, not by a background job: `ok → due → missed`, plus `sos` and `away`. That means it works on serverless with nothing running.
2. **Privacy by construction.** There are no accounts, and a member's token stays in their browser (the server keeps only a hash). Devices are recognised by a random id stored only as a hash, to stop double votes. There is no `innerHTML` anywhere (a test enforces it), a strict Content-Security-Policy, and rate limiting.

Storage is pluggable: Upstash Redis on Vercel for durability, a JSON file locally, and memory for tests. Triage runs on a built-in rule-based classifier, with an optional LLM upgrade that falls back to the rules on any failure.

## Challenges I ran into

- **Designing for the unhappy path.** A missed check-in is usually a dead phone, not a disaster. So there is a grace window, a gentle "due" nudge before anyone is alerted, and the claim step, so that a false alarm costs one neighbour a knock and not a call to the police.
- **Not over-claiming.** It would be easy to make the app look like an emergency service. Instead it says repeatedly, on screen, that it is not, and puts 112 first.
- **A shared demo.** Judges all open the same demo circle, so sample neighbours keep scripted states and a claim made by one visitor is invisible to the next. Otherwise the second judge would find the button already taken. This only came out when I tested two visitors in a row.
- **Testing the map.** My sandbox could not reach the Leaflet CDN, so I tested the map behaviour against a stand-in and kept the app fully usable (search, GPS, city chips, lists) even when the map cannot load.

## Accomplishments I'm proud of

- A complete loop (check-in → missed → "I'll check on them" → resolved) that works with no account.
- Safety-minded details: vetted playbooks, a 112 button on every urgent screen, state shown with words and icons as well as colour, keyboard navigation, and a layout that works at 390 px wide.
- 42 automated tests plus browser tests of the full journey on desktop and mobile.

## What I learned

Good safety design is mostly about restraint: asking for less data, saying what the tool cannot do, and making the false-alarm path cheap.

## What's next

- Delivery beyond the open app: SMS, WhatsApp or web push when a check-in is missed (needs a provider account).
- Hindi and regional-language UI, and voice check-in for people who do not type.
- Society and RWA admin tools, and an offline-first PWA.
- Pilot with one real housing society and one elderly-care group, and learn from it before adding anything else.

## Built with

Node.js, JavaScript, Leaflet, OpenStreetMap, Nominatim, Vercel, Upstash Redis (optional), Claude API (optional)

## Try it

- **Live demo:** [your-vercel-url]
- **Code:** [your-github-url]
- Open the app → My circle → **Open the demo circle** (no sign-up).

---

## Demo video script (about 2 minutes)

1. **0:00 The problem (10 s).** "Most emergencies are noticed by neighbours first. But there is no private, quick way to coordinate."
2. **0:10 Open the demo circle (25 s).** Show the three sample neighbours. Point at Mrs. Iyer, "Missed check-in", at the top. Tap **I'll check on Mrs. Iyer**. "One neighbour takes it, so nobody is double-called."
3. **0:35 Check in and SOS (20 s).** Tap **I'm okay**, then open the SOS panel and show "this does not call emergency services" and the 112 button.
4. **0:55 Map and alerts (35 s).** Alerts tab. Pick Bengaluru, then **Report an alert**. Type "Smell of gas near the lift". Show the auto-detected "Gas leak, urgent", post, and show the **What to do now** card. Show the pin on the map and the radius filter.
5. **1:30 Resources (10 s).** Show first-aid kits and AEDs near the pin, then **I have seen this**.
6. **1:40 Privacy and close (20 s).** "No email, no account, a code and a first name. Deploys to Vercel in two minutes. It is a community aid, and in an emergency, call 112."

## Submission checklist

- [ ] Live URL works: `/api/health` returns `ok`, and the demo circle opens
- [ ] If showing real use, connect Upstash Redis so data is durable (`"persistent": true` in `/api/health`)
- [ ] Add 3 to 5 screenshots: circle, alerts with the map, resources, the mobile view
- [ ] Record the video from the script above (under 3 minutes)
- [ ] Mention that sample data is labelled "Sample"
- [ ] Choose the **Safety & Emergency Response** track
