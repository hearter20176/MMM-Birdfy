Module.register("MMM-Birdfy", {
  defaults: {
    // --- Birdfy highlights (polling mode) ---
    // Feeds to poll: [{ name: "Bird Feeder", uuid: "<share uuid>" }]
    sources: [],
    // How often to poll for new bird sightings (ms)
    pollInterval: 2 * 60 * 1000,
    // Only surface alerts newer than this age (ms)
    maxAlertAge: 30 * 60 * 1000,  // highlights can appear minutes after the visit

    // --- Webhook mode (alternative to polling) ---
    // Enable a local HTTP server to receive push notifications
    // Pair with IFTTT / Home Assistant / etc.
    webhookEnabled: false,
    webhookPort: 8765,
    webhookPath: "/birdfy",

    // --- Display ---
    // How long to show the bird alert before returning to idle (ms)
    displayDuration: 30 * 1000,
    // Show the recorded video clip when available
    showVideo: true,
    // Prefer live stream over the recorded clip
    showLiveView: false,
    // Fade animation speed (ms)
    animationSpeed: 1000,
    // Show module in idle state (false = hide until bird detected)
    showWhenIdle: true,
  },

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  start() {
    Log.info(`[MMM-Birdfy] Starting module`);
    this.alert = null;       // current bird alert being displayed
    this.hideTimer = null;
    this.loaded = false;
    this.sendSocketNotification("BIRDFY_CONFIG", this.config);
  },

  getStyles() {
    return ["MMM-Birdfy.css"];
  },

  getHeader() {
    if (this.alert) return "🐦 Bird Detected!";
    return this.config.showWhenIdle ? "Birdfy" : "";
  },

  // ─── DOM ─────────────────────────────────────────────────────────────────

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "birdfy-wrapper";

    if (!this.loaded && !this.alert) {
      if (this.config.showWhenIdle) {
        wrapper.innerHTML = `<div class="birdfy-idle">
          <span class="birdfy-icon">🪺</span>
          <span class="birdfy-idle-text">Watching for birds…</span>
        </div>`;
      }
      return wrapper;
    }

    if (!this.alert) {
      if (this.config.showWhenIdle) {
        wrapper.innerHTML = `<div class="birdfy-idle">
          <span class="birdfy-icon">🪺</span>
          <span class="birdfy-idle-text">No recent visitors</span>
        </div>`;
      }
      return wrapper;
    }

    // ── Active alert ──────────────────────────────────────────────────────
    const { species, deviceName, timestamp, videoUrl, imageUrl, streamUrl } = this.alert;

    const alert = document.createElement("div");
    alert.className = "birdfy-alert";

    // Media (video, live stream, or thumbnail)
    const mediaUrl = this.config.showLiveView && streamUrl
      ? streamUrl
      : (this.config.showVideo && videoUrl ? videoUrl : imageUrl);

    if (mediaUrl) {
      const mediaEl = this._buildMediaElement(mediaUrl, this.config.showLiveView && streamUrl);
      alert.appendChild(mediaEl);
    }

    // Info overlay
    const info = document.createElement("div");
    info.className = "birdfy-info";

    if (species) {
      const speciesEl = document.createElement("div");
      speciesEl.className = "birdfy-species";
      speciesEl.textContent = species;
      info.appendChild(speciesEl);
    }

    const meta = document.createElement("div");
    meta.className = "birdfy-meta";
    const parts = [];
    if (deviceName) parts.push(deviceName);
    if (timestamp)  parts.push(this._formatTime(timestamp));
    meta.textContent = parts.join(" · ");
    info.appendChild(meta);

    alert.appendChild(info);
    wrapper.appendChild(alert);
    return wrapper;
  },

  _buildMediaElement(url, isStream) {
    if (isStream) {
      // Live stream — use an <img> tag with the MJPEG/still URL or an <iframe>
      const img = document.createElement("img");
      img.className = "birdfy-media";
      img.src = url;
      img.alt = "Live bird feeder view";
      return img;
    }

    const isVideo = /\.(mp4|webm|mov)/i.test(url);
    if (isVideo) {
      const video = document.createElement("video");
      video.className = "birdfy-media";
      video.src = url;
      video.autoplay = true;
      video.muted = true;
      video.loop = false;
      video.controls = false;
      video.playsInline = true;
      return video;
    }

    const img = document.createElement("img");
    img.className = "birdfy-media";
    img.src = url;
    img.alt = "Bird detection";
    return img;
  },

  _formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  },

  // ─── Socket notifications (from node_helper) ─────────────────────────────

  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case "BIRDFY_READY":
        this.loaded = true;
        this.updateDom(this.config.animationSpeed);
        break;

      case "BIRDFY_ALERT":
        this._showAlert(payload);
        break;

      case "BIRDFY_ERROR":
        Log.error(`[MMM-Birdfy] ${payload.message}`);
        break;
    }
  },

  // ─── Alert display logic ──────────────────────────────────────────────────

  _showAlert(alertData) {
    Log.info(`[MMM-Birdfy] Bird detected: ${alertData.species || "unknown"}`);

    // Clear any existing hide timer
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }

    this.alert = alertData;
    this.loaded = true;
    this.updateDom(this.config.animationSpeed);

    // Schedule auto-dismiss
    this.hideTimer = setTimeout(() => {
      this.alert = null;
      this.hideTimer = null;
      this.updateDom(this.config.animationSpeed);
    }, this.config.displayDuration);
  },

  // ─── Broadcast to other modules ───────────────────────────────────────────

  notificationReceived(notification, payload) {
    // Allow other modules or the config to trigger a demo alert
    if (notification === "BIRDFY_DEMO") {
      this._showAlert({
        species: payload?.species || "House Sparrow",
        deviceName: payload?.deviceName || "Garden Feeder",
        timestamp: Date.now(),
        imageUrl: payload?.imageUrl || null,
        videoUrl: payload?.videoUrl || null,
        streamUrl: payload?.streamUrl || null,
      });
    }
  },
});
