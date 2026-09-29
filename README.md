# MMM-Birdfy

A [MagicMirror²](https://magicmirror.builders) module that displays bird-detection alerts from your **Birdfy** smart feeder camera — showing the recorded video clip, a thumbnail, or a live stream whenever a bird is spotted.

---

## Features

- Shows video clip or thumbnail image on every bird detection
- Displays AI-identified bird species name
- Supports optional **live view** instead of the recorded clip
- Auto-dismisses after a configurable duration and returns to idle state
- Two integration modes: **direct cloud polling** or **webhook push**
- Broadcast `BIRDFY_DEMO` notification from any other module for testing

---

## Installation

```bash
cd ~/MagicMirror/modules
git clone <this repository's clone URL> MMM-Birdfy
cd MMM-Birdfy
npm install
```

---

## Configuration

Add to the `modules` array in `config/config.js`:

```javascript
{
  module: "MMM-Birdfy",
  position: "top_right",   // any MagicMirror region
  config: {
    // ── Mode A: Birdfy highlights polling ─────────────────────────
    sources: [
      { name: "Bird Feeder", uuid: "your-share-uuid" },
      { name: "Bird House",  uuid: "another-share-uuid" },
    ],
    pollInterval: 120000,     // check every 2 min
    maxAlertAge: 1800000,     // ignore visits older than 30 min

    // ── Mode B: Webhook (IFTTT / Home Assistant / etc.) ───────────
    webhookEnabled: false,    // set true to enable
    webhookPort:    8765,
    webhookPath:    "/birdfy",
    webhookHost:    "127.0.0.1",  // localhost only by default; see "Security" below
    webhookToken:   "",           // set a shared secret to require it on every request

    // ── Display ───────────────────────────────────────────────────
    displayDuration: 30000,   // show alert for 30 s
    showVideo:       true,    // play video clip if available
    showLiveView:    false,   // prefer live stream over clip
    showWhenIdle:    true,    // show idle state between alerts
    maxVisitors:     8,       // max species shown in the today's-visitors grid
    animationSpeed:  1000,
  }
},
```

---

## Integration Modes

### Mode A — Birdfy Highlights Polling

Add one entry to `sources` per Birdfy feeder, each with the share UUID from the Birdfy app (the same UUID the Home Assistant Birdfy integration uses). No account login is needed. The node helper polls `https://api2.nvts.co/moments/h5CuratedData` for today's data every `pollInterval` milliseconds and shows two kinds of events:

- **Species sightings** — the first time an identified species appears in today's `birdList`, with Birdfy's cover photo for that species. This is the frequent signal; Birdfy's share feed does not expose exact sighting times or repeat visits, so each species is announced once per day.
- **Curated clips** — highlights Birdfy selects (typically a few per week), with the video clip, shown if newer than `maxAlertAge`.

#### Getting (or renewing) a share UUID

1. Open the Birdfy app and tap your profile image (top right).
2. Select **Highlights**. A browser page opens.
3. Copy that page's URL; the UUID is the value after `uuid=`
   (`https://highlight.birdfy.com/?uuid=YOUR_UUID_HERE`).

Birdfy can invalidate these links (for example after an app update). An invalid UUID
returns an empty feed rather than an error, so when a source has no highlights today the
module also checks Birdfy's highlight summary for the last ~2 months (at most every 6 hours).
If that is empty too, it logs a warning and the idle view shows
`Birdfy link expired: <source name>` until the source returns data again.

### Mode B — Webhook

Set `webhookEnabled: true`. The module starts an Express server on `webhookPort` (default `8765`) at `webhookPath` (default `/birdfy`).

POST a JSON payload to `http://<mirror-ip>:8765/birdfy` to trigger an alert:

```json
{
  "species":    "House Sparrow",
  "deviceName": "Garden Feeder",
  "timestamp":  1700000000000,
  "videoUrl":   "https://example.com/clip.mp4",
  "imageUrl":   "https://example.com/cover.jpg",
  "streamUrl":  "https://example.com/live.mjpg"
}
```

All fields are optional; only recognised fields are displayed. `videoUrl`/`imageUrl`/`streamUrl` must be `http://` or `https://` URLs — anything else (e.g. `rtmp://`) is silently dropped. `streamUrl` (used when `showLiveView: true`) is rendered as an `<img>` tag, so it must point at an MJPEG stream or a still/snapshot URL, not an RTMP or HLS (`.m3u8`) address.

#### Security

By default the webhook server binds to `127.0.0.1` (localhost) and is **not** reachable from the rest of your network — only processes on the mirror itself (or an SSH tunnel) can reach it. It also has no authentication unless you set `webhookToken`.

- **To let another host on your LAN (e.g. a Home Assistant server) reach the webhook**, set `webhookHost: "0.0.0.0"` in the module config. Once you do this, anyone on your LAN can reach the endpoint, so also set `webhookToken` to a random shared secret.
- **To require a shared secret**, set `webhookToken: "<a long random string>"`. Callers must then send it as either:
  - an `Authorization: Bearer <token>` header, or
  - a `?token=<token>` query parameter (useful for services like IFTTT that can't set custom headers).

  Requests without a valid token receive `HTTP 401`.

#### Setting up IFTTT

The webhook binds to `127.0.0.1` by default, which IFTTT — a cloud service — cannot reach at
all. To use IFTTT you must both expose the webhook and require a token:

1. Set `webhookHost: "0.0.0.0"` and `webhookToken: "<a long random string>"` in the module
   config, then make `webhookPort` reachable from the public internet (e.g. a reverse proxy
   or a tunnel such as Cloudflare Tunnel/ngrok/Tailscale Funnel — do not port-forward straight
   to your mirror without at least the token set). IFTTT cannot set custom headers, so the
   token must go in the URL's query string.
2. Create an IFTTT applet: **If** Birdfy notification → **Then** Webhooks (make a web request).
3. Set the URL to `https://<your-public-endpoint>/birdfy?token=<your-webhookToken>`.
4. Method: `POST`, Content type: `application/json`.
5. Body: `{"species":"{{BirdName}}","deviceName":"{{FeederName}}","imageUrl":"{{ImageUrl}}"}` *(adjust ingredient names to match the Birdfy IFTTT service)*.

#### Setting up Home Assistant

If Home Assistant runs on a different host than the mirror, set `webhookHost: "0.0.0.0"` and
`webhookToken: "<a long random string>"` in the module config first (see "Security" above) —
otherwise Home Assistant will get connection refused against the localhost-only default.

```yaml
automation:
  - alias: Birdfy → MagicMirror
    trigger:
      platform: state
      entity_id: binary_sensor.birdfy_motion
      to: "on"
    action:
      service: rest_command.birdfy_mirror
---
rest_command:
  birdfy_mirror:
    url: "http://<mirror-ip>:8765/birdfy"
    method: POST
    content_type: "application/json"
    headers:
      Authorization: "Bearer <your-webhookToken>"
    payload: >
      {"species":"{{ states('sensor.birdfy_species') }}",
       "imageUrl":"{{ states('sensor.birdfy_image_url') }}"}
```

---

## Testing without a device

Send the `BIRDFY_DEMO` notification from the browser console. Core requires the sender of a
notification to be a module instance (`MM.sendNotification` alone will fail with "Sender
should be a module"), so send it through the MMM-Birdfy instance itself:

```javascript
// Browser console on your MagicMirror
const birdfy = MM.getModules().withClass("MMM-Birdfy")[0];
birdfy.notificationReceived("BIRDFY_DEMO", {
  species:    "Blue Jay",
  deviceName: "Front Feeder",
  imageUrl:   "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f4/Blue_jay_in_PP_%2830960%29.jpg/320px-Blue_jay_in_PP_%2830960%29.jpg"
}, birdfy);
```

---

## Errors & status

- If `sources` is empty and `webhookEnabled` is `false`, the module has nothing to do and shows
  that fact instead of a misleading "No visitors yet today": *No Birdfy sources configured...*
- If the Birdfy API for a given source is unreachable (network failure, timeout, non-2xx
  response), the idle view adds a line naming that source: *`<source name>` unreachable since
  HH:MM*. Each source's error is tracked separately (so one source recovering does not hide
  another source's outage) and keeps the time the outage was first seen, not the time of the
  most recent retry; each clears automatically on that source's next successful poll.
- If a source's share UUID has expired, the idle view shows *Birdfy link expired: `<source name>`*
  (see "Getting (or renewing) a share UUID" above).
- If the webhook server fails to bind (e.g. `webhookPort` already in use), a dedicated line is
  shown (e.g. *Webhook port 8765 in use*) and is **not** cleared by source polls succeeding —
  it stays until something rebinds a free port. That happens on module restart, or simply on
  the next browser reload (which re-sends the module's config and retries the bind).

---

## Migrating from apiEmail/apiPassword/deviceIds

Older drafts of this module's config used an `apiEmail`/`apiPassword`/`deviceIds`-based login.
The module no longer supports account login — Birdfy's highlights feed is read via the public,
unauthenticated share-UUID endpoint instead (see "Getting (or renewing) a share UUID" above).
If your config still has these keys:

1. Delete the `apiEmail` and `apiPassword` lines (do not leave a plaintext password sitting in
   an unused config key).
2. Get a share UUID per feeder as described above and add a `sources` array:
   `sources: [{ name: "Bird Feeder", uuid: "your-share-uuid" }]`.

The module always logs a warning if it sees these keys (without printing their values), but it
never reads them. It also shows a non-blocking warning banner on the mirror itself — *apiEmail/
apiPassword/deviceIds are no longer used...* — whenever these keys are present **and no
`sources` are configured**, even if `webhookEnabled: true` is also set (the legacy keys never
configured the webhook either, so a config with only those keys is not actually receiving any
alerts). If `sources` is already configured alongside the leftover legacy keys, only the log
warning fires; nothing appears on the mirror.

---

## Config Reference

| Key | Default | Description |
|---|---|---|
| `sources` | `[]` | Highlight feeds to poll: `[{ name, uuid }]` (polling mode) |
| `pollInterval` | `120000` | Polling frequency in ms |
| `maxAlertAge` | `1800000` | Max age of a visit to surface (ms) |
| `webhookEnabled` | `false` | Enable webhook server |
| `webhookPort` | `8765` | Webhook server port |
| `webhookPath` | `"/birdfy"` | Webhook URL path |
| `webhookHost` | `"127.0.0.1"` | Webhook bind address; `"0.0.0.0"` to expose it to the LAN |
| `webhookToken` | `""` | Optional shared secret required on every webhook request |
| `displayDuration` | `30000` | How long to show an alert (ms) |
| `showVideo` | `true` | Show video clip when available |
| `showLiveView` | `false` | Prefer live stream over recorded clip |
| `showWhenIdle` | `true` | Between alerts, show today's identified visitors (photo grid) or "No visitors yet today" |
| `maxVisitors` | `8` | Max species shown in the today's-visitors grid |
| `animationSpeed` | `1000` | DOM update fade speed (ms) |

---

## License

MIT
