# PadosiSafe

**Neighbours looking out for neighbours.** A neighbour check-in circle and hyperlocal safety board for India, with a map you can pin to any street. No sign-up, no email, no API keys.

Built solo for the **Safety & Emergency Response** track of Neighborhood Hacks.

> *Padosi* (पड़ोसी) means neighbour. PadosiSafe is a community tool and **does not replace** the police, fire brigade or ambulance. In an emergency, call **112**.

## The problem

Most emergencies in a neighbourhood are found by neighbours first: the elderly person living alone who has not opened their door for two days, the gas smell in the stairwell, the waterlogged underpass. But there is no quick, private way to *notice* and *coordinate*. Group chats bury the signal, and apps ask for accounts, emails and phone numbers that people (especially older people) will not give.

## What it does

| | Feature | How it helps |
|---|---|---|
| 🏠 | **Check-in circles** | A few neighbours check in with one tap ("I'm okay"). Miss it and the circle sees you at the top of the list. One neighbour taps *"I'll check on them"* so nobody is double-called and nobody is left alone. |
| 🆘 | **SOS to your circle** | One tap, an optional note, and your location if you allow it. It tells you plainly that it does *not* call emergency services and puts a **Call 112** button first. |
| 🌙 | **Away mode** | Travelling or in hospital? Pause check-ins so no one worries. |
| ⚠️ | **Hyperlocal alert board** | Anyone can report a hazard at a map pin. A built-in triage picks the type and urgency (English, Hinglish and Devanagari keywords). Neighbours confirm; alerts expire on their own; two neighbours can close one. |
| 📋 | **"What to do now"** | Every alert type has a short, vetted playbook (gas leak, fire, flood, power cut...). The AI never writes safety advice. It only classifies. |
| 🗺️ | **India map** | Leaflet + OpenStreetMap. Search any place in India, jump to a city, use GPS, or tap/drag a pin. Everything sorts by distance from your pin, with a radius filter. Pins outside India are rejected. |
| 🩹 | **Community resource map** | First-aid kits, extinguishers, AEDs, shelters, pharmacies and trained first-aiders. Neighbours add and *verify* them. |
| 📞 | **Help tab** | One-tap India emergency numbers (112, 100, 101, 108, 1091, 1098, 1906). They also work if the server is down. |

### Privacy by design

- **No email, phone number or account.** A circle is a code (like `NEEM-LOTUS-4821`) and a first name.
- A member's secret token lives only in their browser. The server stores a **hash** of it.
- Devices are recognised by a random id that is stored only as a one-way hash, to stop double votes.
- Your pin is used to sort what is near you and is **not stored** unless you post an alert, add a resource or send an SOS.
- When the last person leaves, the circle is deleted. With Redis storage, idle circles also expire after 60 days.
- Strict Content-Security-Policy, no `innerHTML` anywhere (a test enforces it), rate limiting, and input length limits.

## Try it in 30 seconds

Open the app → **My circle** → **Open the demo circle**. It has three sample neighbours: one okay, one running late and one who missed a check-in. Tap *"I'll check on Mrs. Iyer"*, then the **Alerts** and **Resources** tabs. Everything marked *Sample* is clearly labelled sample data.

## Deploy to Vercel (about 2 minutes)

1. Push this folder to a GitHub repo (see below).
2. On [vercel.com/new](https://vercel.com/new), **Import** the repo. Leave every setting as it is. `vercel.json` already configures the static site and the API.
3. Click **Deploy**. Open `https://<your-project>.vercel.app/api/health`. You should see `{"ok":true,...}`.

That is all. No environment variables are required.

**Making data durable (recommended for a real pilot):** without a database, Vercel serverless functions keep data in memory, so it resets when the function restarts. The app tells you this in `/api/health` (`"persistent": false`). To keep circles, alerts and resources:

- In your Vercel project, open **Storage → Marketplace → Upstash Redis** (free tier) and connect it. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically, and PadosiSafe picks them up. Redeploy.

**Optional LLM triage:** set `ANTHROPIC_API_KEY` for model-based triage. Without it the built-in rule-based classifier is used, and any model failure falls back to it silently.

### Push to GitHub

```bash
git remote add origin https://github.com/<you>/padosisafe.git
git branch -M main
git push -u origin main
```

(or with the GitHub CLI: `gh repo create padosisafe --public --source=. --push`)

## Run locally

Requires Node 22+. **There are no dependencies to install.**

```bash
npm start            # http://localhost:3000  (data saved to data/db.json)
npm test             # 42 unit and API tests, no network needed
```

### Browser tests (optional)

Drive the real UI in Chromium with Playwright for Python (`pip install playwright`):

```bash
PADOSI_STORE=memory npm start &      # start on a fresh, empty store
python3 e2e/ui.py                    # full user journey, desktop + mobile
python3 e2e/map.py                   # map behaviour, against a Leaflet stand-in
```

## How it is built

```
public/            static frontend (plain JS modules, no build step)
  app.js             UI: location bar, circle, alerts, resources, help
  js/map.mjs         Leaflet + OSM wrapper (loads from CDN, degrades gracefully)
  js/geo.mjs         place search + reverse geocoding (OSM Nominatim, India only)
  js/util.mjs        pure helpers and display metadata
api/index.js       Vercel serverless entry (rewrites /api/* here)
lib/
  app.js             HTTP routes, validation, rate limiting
  logic.js           pure logic: check-in states, geo maths, alert expiry
  ai.js              triage: rule-based classifier + optional LLM
  playbooks.js       vetted "what to do now" guidance + emergency numbers
  store.js           Upstash Redis | JSON file | in-memory
  seed.js            labelled sample data and the demo circle
server.js          local dev server (not used on Vercel)
test/  e2e/        unit + API tests, browser tests
```

**Stack:** Node 22 (zero dependencies), vanilla JS modules, Leaflet 1.9, OpenStreetMap, Nominatim. Deliberately tiny so it deploys anywhere and is easy to audit.

### How a missed check-in works

Each member picks how often they check in (6, 12, 24 or 48 hours) and a grace period (30 min to 4 h). Status is **computed from the clock**, not from a background job, so it works on serverless with nothing running:

`ok` → *due* (overdue, still in grace: nudge the person) → *missed* (circle is alerted) · plus `sos` and `away`

### API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health`, `/api/config` | status, storage mode, options, emergency numbers, playbooks |
| POST | `/api/triage` | `{text}` → category, urgency, summary |
| POST | `/api/circles`, `/api/circles/join` | create / join; returns a member token (shown once) |
| GET | `/api/circles/:code` | needs `x-member-token` |
| POST | `/api/circles/:code/{checkin,settings,away,sos,leave}` | member actions |
| POST | `/api/circles/:code/members/:id/{claim,resolve}` | "I'll check on them" / "they're fine" |
| GET/POST | `/api/alerts` | `?lat&lng&radiusKm&severity`; post `{text,lat,lng,clientId}` |
| POST | `/api/alerts/:id/{confirm,resolve}` | one vote per device |
| GET/POST | `/api/places` · POST `/api/places/:id/verify` | community resources |

## Honest limitations

- **It is a community aid, not an alerting service.** There is no push notification or SMS: a circle sees a missed check-in when members open the app (it refreshes every 20 seconds while open). SMS/WhatsApp/push delivery is the obvious next step and needs a provider account, so it is left out here.
- **Alerts are unverified** by design. They rely on confirmation by neighbours, and the app says so.
- The rule-based triage is a keyword classifier. It is quick and works offline, but it can be wrong, so the poster can always override the type and urgency.
- The optional LLM triage is covered by tests with a mocked API response, but it has not been run against the live API. The built-in rules are the default.
- Map tiles and place search use OpenStreetMap's free public services, which have usage policies. For real traffic, use your own tile and geocoding provider.
- Without a database on Vercel, data is not durable (see above).
- Sample data (the demo circle, sample alerts and resources) is placeholder content, not real incidents or facilities.

## License

MIT
