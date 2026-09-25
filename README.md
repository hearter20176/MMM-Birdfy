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
git clone https://github.com/YOUR_USERNAME/MMM-Birdfy.git
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

    // ── Display ───────────────────────────────────────────────────
    displayDuration: 30000,   // show alert for 30 s
    showVideo:       true,    // play video clip if available
    showLiveView:    false,   // prefer live stream over clip
    showWhenIdle:    true,    // show idle state between alerts
    animationSpeed:  1000,
  }
},
```

---

## Integration Modes

### Mode A — Birdfy Highlights Polling

Add one entry to `sources` per Birdfy feeder, each with the share UUID from the Birdfy app (the same UUID the Home Assistant Birdfy integration uses). No account login is needed. The node helper polls `https://api2.nvts.co/moments/h5CuratedData` for today's highlights every `pollInterval` milliseconds and shows each newly identified bird visit newer than `maxAlertAge`, with its clip (`fileUrl`) and species thumbnail.

> **Note:** an unknown UUID returns an empty feed rather than an error. If a source returns nothing for 24 hours, the module logs a warning to check the UUID.

### Mode B — Webhook

Set `webhookEnabled: true`. The module starts an Express server on `webhookPort` (default `8765`) at `webhookPath` (default `/birdfy`).

POST a JSON payload to `http://<mirror-ip>:8765/birdfy` to trigger an alert:

```json
{
  "species":    "House Sparrow",
  "deviceName": "Garden Feeder",
  "timestamp":  1700000000000,
  "videoUrl":   "https://...",
  "imageUrl":   "https://...",
  "streamUrl":  "rtmp://..."
}
```

All fields are optional; only recognised fields are displayed.

#### Setting up IFTTT

1. Create an IFTTT applet: **If** Birdfy notification → **Then** Webhooks (make a web request).
2. Set the URL to `http://<mirror-ip>:8765/birdfy`.
3. Method: `POST`, Content type: `application/json`.
4. Body: `{"species":"{{BirdName}}","deviceName":"{{FeederName}}","imageUrl":"{{ImageUrl}}"}` *(adjust ingredient names to match the Birdfy IFTTT service)*.

#### Setting up Home Assistant

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
    payload: >
      {"species":"{{ states('sensor.birdfy_species') }}",
       "imageUrl":"{{ states('sensor.birdfy_image_url') }}"}
```

---

## Testing without a device

Send the `BIRDFY_DEMO` notification from the browser console or another module:

```javascript
// Browser console on your MagicMirror
MM.sendNotification("BIRDFY_DEMO", {
  species:    "Blue Jay",
  deviceName: "Front Feeder",
  imageUrl:   "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f4/Blue_jay_in_PP_%2830960%29.jpg/320px-Blue_jay_in_PP_%2830960%29.jpg"
});
```

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
| `displayDuration` | `30000` | How long to show an alert (ms) |
| `showVideo` | `true` | Show video clip when available |
| `showLiveView` | `false` | Prefer live stream over recorded clip |
| `showWhenIdle` | `true` | Show idle message between alerts |
| `animationSpeed` | `1000` | DOM update fade speed (ms) |

---

## License

MIT
