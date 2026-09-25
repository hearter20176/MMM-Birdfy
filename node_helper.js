/**
 * node_helper.js — MMM-Birdfy
 *
 * Handles two ways of receiving bird-detection events from Birdfy:
 *
 *  1. HIGHLIGHTS MODE – polls the Birdfy (Netvue) highlights feed for each
 *     configured source. Each source is identified by the share UUID from the
 *     Birdfy app, the same one the Home Assistant Birdfy integration uses.
 *     No account login is needed.
 *
 *  2. WEBHOOK MODE    – starts a local Express server so that external services
 *     (IFTTT, Home Assistant, etc.) can POST bird-detection payloads directly.
 *
 * Endpoint: GET https://api2.nvts.co/moments/h5CuratedData
 *           ?uuid=<share uuid>&startTime=<ms>&endTime=<ms>
 * Response: { birdList: [{ name, coverKey }], dataList: [{ detectObject,
 *             title, category, createTime, fileUrl }], message? }
 * An unknown UUID returns HTTP 200 with an empty dataList, not an error.
 */

"use strict";

const NodeHelper = require("node_helper");
const axios      = require("axios");
const express    = require("express");

const HIGHLIGHTS_URL   = "https://api2.nvts.co/moments/h5CuratedData";
const ERROR_SUMMARY_MS = 15 * 60 * 1000;
// Warn if a source has returned nothing for this long (likely a wrong UUID).
const EMPTY_WARN_MS    = 24 * 60 * 60 * 1000;

// ── Birdfy highlights client ──────────────────────────────────────────────────

class BirdfyHighlights {
  constructor(source) {
    this.name = source.name || "Birdfy";
    this.uuid = source.uuid;
    this.http = axios.create({ timeout: 30000 });
  }

  // Today's highlights (local midnight → end of day), as the HA integration does.
  async getToday() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
    const res = await this.http.get(HIGHLIGHTS_URL, {
      params: { uuid: this.uuid, startTime: String(start.getTime()), endTime: String(end.getTime()) },
    });
    const data = res.data;
    if (!data || typeof data !== "object") throw new Error("Unexpected response from Birdfy API");
    if (data.message) throw new Error(data.message);
    return data;
  }
}

// ── Convert a highlight item into the alert shape the frontend renders ────────

function toAlert(item, thumbnails, sourceName) {
  const species = item.detectObject || null;
  return {
    id:         `${item.createTime}-${item.fileUrl || species || ""}`,
    species,
    deviceName: sourceName,
    timestamp:  Number(item.createTime) || Date.now(),
    videoUrl:   item.fileUrl || null,
    imageUrl:   (species && thumbnails[species]) || null,
    streamUrl:  null,
    isNewSpecies: item.category === "newBird",
  };
}

// ── Normalise a webhook payload into the same shape ───────────────────────────

function normaliseAlert(raw, deviceName) {
  return {
    id:         raw.id       || raw.alertId   || String(Date.now()),
    species:    raw.species  || raw.birdName  || raw.label || null,
    deviceName: deviceName   || raw.deviceName || raw.device_name || null,
    // Prefer a unix-ms timestamp; fall back to ISO string
    timestamp:  raw.timestamp || raw.created_at
      ? new Date(raw.timestamp || raw.created_at).getTime()
      : Date.now(),
    videoUrl:   raw.videoUrl || raw.video_url  || raw.clip_url  || null,
    imageUrl:   raw.imageUrl || raw.image_url  || raw.thumb_url || raw.thumbnailUrl || null,
    streamUrl:  raw.streamUrl || raw.stream_url || null,
  };
}

// ── node_helper ───────────────────────────────────────────────────────────────

module.exports = NodeHelper.create({
  start() {
    console.log("[MMM-Birdfy] node_helper started");
    this.config        = null;
    this.pollTimer     = null;
    this.sources       = [];
    this.webhookApp    = null;
    this.webhookServer = null;
  },

  // ── Receive config from the frontend ───────────────────────────────────────

  socketNotificationReceived(notification, payload) {
    if (notification !== "BIRDFY_CONFIG") return;

    this.config = payload;

    if (payload.webhookEnabled && !this.webhookServer) {
      this._startWebhookServer();
    }

    const sources = (payload.sources || []).filter((s) => s && s.uuid);
    if (sources.length) {
      this._startPolling(sources);
    } else if (!payload.webhookEnabled) {
      console.warn("[MMM-Birdfy] No sources configured and webhook disabled. Module is idle.");
    }

    this.sendSocketNotification("BIRDFY_READY", {});
  },

  // ── Highlights polling ─────────────────────────────────────────────────────

  _startPolling(sources) {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.sources = sources.map((s) => ({
      api:          new BirdfyHighlights(s),
      seen:         new Set(),
      errorCount:   0,
      lastErrorLog: 0,
      lastData:     Date.now(),
      warnedEmpty:  false,
    }));
    console.log(`[MMM-Birdfy] Polling ${this.sources.length} Birdfy source(s) every ${this.config.pollInterval / 1000}s`);
    this._pollAll();
    this.pollTimer = setInterval(() => this._pollAll(), this.config.pollInterval);
  },

  async _pollAll() {
    for (const src of this.sources) {
      await this._pollSource(src);
    }
  },

  async _pollSource(src) {
    let data;
    try {
      data = await src.api.getToday();
    } catch (err) {
      this._logSourceError(src, err);
      return;
    }
    if (src.errorCount > 0) {
      console.log(`[MMM-Birdfy] ${src.api.name}: recovered after ${src.errorCount} failed poll(s)`);
      src.errorCount = 0;
    }

    const items = Array.isArray(data.dataList) ? data.dataList : [];
    const thumbnails = {};
    for (const bird of data.birdList || []) {
      if (bird && bird.name && bird.coverKey) thumbnails[bird.name] = bird.coverKey;
    }

    if (items.length) {
      src.lastData = Date.now();
      src.warnedEmpty = false;
    } else if (!src.warnedEmpty && Date.now() - src.lastData > EMPTY_WARN_MS) {
      console.warn(`[MMM-Birdfy] ${src.api.name}: no highlights for 24h; check the source uuid`);
      src.warnedEmpty = true;
    }

    const now = Date.now();
    const fresh = items
      .map((item) => toAlert(item, thumbnails, src.api.name))
      .filter((a) => !src.seen.has(a.id))
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const alert of fresh) {
      src.seen.add(alert.id);
      // Only alert on identified birds recent enough to be interesting. On the
      // first poll this still surfaces a visit from the last maxAlertAge window.
      if (!alert.species) continue;
      if (now - alert.timestamp > this.config.maxAlertAge) continue;
      this.sendSocketNotification("BIRDFY_ALERT", alert);
    }

    // Seen ids only matter for today's feed; drop them when the day rolls over.
    if (src.seen.size > 500) src.seen = new Set(items.map((i) => toAlert(i, thumbnails, src.api.name).id));
  },

  // Log the first failure of an outage, then a summary at most every 15 minutes.
  _logSourceError(src, err) {
    src.errorCount += 1;
    const now = Date.now();
    if (src.errorCount === 1 || now - src.lastErrorLog >= ERROR_SUMMARY_MS) {
      const suffix = src.errorCount > 1 ? ` (${src.errorCount} failed polls so far)` : "";
      this._sendError(`${src.api.name}: ${err.message}${suffix}`);
      src.lastErrorLog = now;
    }
  },

  // ── Webhook server ─────────────────────────────────────────────────────────

  _startWebhookServer() {
    this.webhookApp = express();
    this.webhookApp.use(express.json());

    const path = this.config.webhookPath || "/birdfy";

    this.webhookApp.post(path, (req, res) => {
      console.log("[MMM-Birdfy] Webhook received", req.body);
      try {
        const alert = normaliseAlert(req.body, req.body.deviceName);
        if (!alert.species) return res.status(200).json({ ok: true, skipped: "no species identified" });
        this.sendSocketNotification("BIRDFY_ALERT", alert);
        res.status(200).json({ ok: true });
      } catch (err) {
        console.error("[MMM-Birdfy] Webhook parse error:", err.message);
        res.status(400).json({ error: err.message });
      }
    });

    // Health-check endpoint
    this.webhookApp.get(path, (_req, res) => res.json({ module: "MMM-Birdfy", status: "ok" }));

    const port = this.config.webhookPort || 8765;
    this.webhookServer = this.webhookApp.listen(port, () => {
      console.log(`[MMM-Birdfy] Webhook server listening on port ${port} at ${path}`);
    });
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _sendError(message) {
    console.error(`[MMM-Birdfy] ${message}`);
    this.sendSocketNotification("BIRDFY_ERROR", { message });
  },

  // Clean up when MagicMirror stops
  stop() {
    clearInterval(this.pollTimer);
    clearTimeout(this.pollTimer);
    if (this.webhookServer) this.webhookServer.close();
  },
});
