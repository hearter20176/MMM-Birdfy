/**
 * node_helper.js — MMM-Birdfy
 *
 * Handles two modes of receiving bird-detection events from Birdfy:
 *
 *  1. POLLING MODE  – authenticates with the Birdfy cloud API and polls for
 *     new detection events on a configurable interval.
 *
 *  2. WEBHOOK MODE  – starts a local Express server so that external services
 *     (IFTTT, Home Assistant, etc.) can POST bird-detection payloads directly.
 *
 * ── IMPORTANT: Birdfy API ────────────────────────────────────────────────────
 * Birdfy / Netvue does not publish an official public API. The endpoint paths
 * below were inferred from the web client (my.birdfy.com) and community
 * research, and MAY need adjustment. To discover the real endpoints:
 *   1. Open my.birdfy.com in Chrome DevTools → Network tab.
 *   2. Log in and browse your bird events.
 *   3. Note the XHR/Fetch requests and update the constants in BirdfyAPI below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const NodeHelper = require("node_helper");
const axios      = require("axios");
const express    = require("express");

// ── Birdfy Cloud API wrapper ──────────────────────────────────────────────────

class BirdfyAPI {
  constructor(baseUrl) {
    // Update this if you discover the real base URL via DevTools
    this.baseUrl = baseUrl || "https://app-api.birdfy.com";
    this.token   = null;
    this.http    = axios.create({ baseURL: this.baseUrl, timeout: 15000 });
  }

  async login(email, password) {
    // Endpoint and body shape to be confirmed via DevTools inspection.
    const res = await this.http.post("/v1/user/login", {
      account:  email,
      password: password,
    });
    // Adjust the path below to wherever the token lives in the response
    this.token = res.data?.data?.token || res.data?.token;
    if (!this.token) throw new Error("Login succeeded but no token found in response");
    this.http.defaults.headers.common["Authorization"] = `Bearer ${this.token}`;
    return this.token;
  }

  async getDevices() {
    const res = await this.http.get("/v1/device/list");
    return res.data?.data?.list || res.data?.data || [];
  }

  async getRecentAlerts(deviceId, pageSize = 20) {
    const params = { page: 1, pageSize };
    if (deviceId) params.deviceId = deviceId;
    const res = await this.http.get("/v1/device/alert/list", { params });
    return res.data?.data?.list || res.data?.data || [];
  }

  async getLiveStreamUrl(deviceId) {
    const res = await this.http.get(`/v1/device/stream/${deviceId}`);
    return res.data?.data?.url || res.data?.url || null;
  }
}

// ── Normalise a raw API alert into a consistent shape ─────────────────────────

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
    this.config       = null;
    this.api          = null;
    this.pollTimer    = null;
    this.seenAlertIds = new Set();
    this.webhookApp   = null;
    this.webhookServer = null;
  },

  // ── Receive config from the frontend ───────────────────────────────────────

  socketNotificationReceived(notification, payload) {
    if (notification !== "BIRDFY_CONFIG") return;

    this.config = payload;
    this.api    = new BirdfyAPI(payload.apiBaseUrl);

    if (payload.webhookEnabled) {
      this._startWebhookServer();
    }

    if (payload.apiEmail && payload.apiPassword) {
      this._startPolling();
    } else if (!payload.webhookEnabled) {
      console.warn("[MMM-Birdfy] No credentials and webhook disabled. Module is idle.");
    }

    this.sendSocketNotification("BIRDFY_READY", {});
  },

  // ── Polling ────────────────────────────────────────────────────────────────

  async _startPolling() {
    try {
      await this.api.login(this.config.apiEmail, this.config.apiPassword);
      console.log("[MMM-Birdfy] Authenticated with Birdfy API");
    } catch (err) {
      this._sendError(`Authentication failed: ${err.message}`);
      // Retry after one interval
      this.pollTimer = setTimeout(() => this._startPolling(), this.config.pollInterval);
      return;
    }

    await this._poll();
    this.pollTimer = setInterval(() => this._poll(), this.config.pollInterval);
  },

  async _poll() {
    try {
      const devicesFilter = new Set(this.config.deviceIds);
      let devices = await this.api.getDevices();

      if (devicesFilter.size > 0) {
        devices = devices.filter(d => devicesFilter.has(d.id || d.deviceId));
      }

      for (const device of devices) {
        const deviceId   = device.id || device.deviceId;
        const deviceName = device.name || device.deviceName || deviceId;
        const alerts     = await this.api.getRecentAlerts(deviceId);

        for (const raw of alerts) {
          const alert = normaliseAlert(raw, deviceName);

          // Skip already-seen, too-old, or unidentified alerts
          if (this.seenAlertIds.has(alert.id)) continue;
          const age = Date.now() - alert.timestamp;
          if (age > this.config.maxAlertAge) continue;
          if (!alert.species) continue; // only trigger when Birdfy identified a bird

          this.seenAlertIds.add(alert.id);

          // Optionally fetch live stream URL
          if (this.config.showLiveView) {
            try {
              alert.streamUrl = await this.api.getLiveStreamUrl(deviceId);
            } catch (_) { /* stream URL is optional */ }
          }

          this.sendSocketNotification("BIRDFY_ALERT", alert);
        }
      }
    } catch (err) {
      this._sendError(`Poll failed: ${err.message}`);

      // Re-auth on token expiry (HTTP 401)
      if (err.response?.status === 401) {
        clearInterval(this.pollTimer);
        this._startPolling();
      }
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
