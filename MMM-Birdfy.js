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
    // Interface the webhook server binds to. Defaults to localhost only;
    // set to "0.0.0.0" to accept requests from elsewhere on the LAN (e.g.
    // Home Assistant on another host) — see README for the security notes.
    webhookHost: "127.0.0.1",
    // Optional shared secret. When set, requests must include it as either
    // an `Authorization: Bearer <token>` header or a `?token=<token>` query
    // parameter, or they are rejected with HTTP 401.
    webhookToken: "",

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
    // Max species shown in the "Today's visitors" idle view
    maxVisitors: 8,
  },

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  start() {
    Log.info(`[MMM-Birdfy] Starting module`);
    this.alert = null;       // current bird alert being displayed
    this.hideTimer = null;
    this.loaded = false;
    this.invalidSources = [];  // sources whose Birdfy share link has expired
    this.todayVisitors = [];   // identified species seen today (from node_helper)
    this.configError = null;   // e.g. no sources configured and webhook disabled
    this.configWarning = null; // e.g. deprecated config keys present but unused
    // Unrecovered errors keyed by origin (a source's uuid, or "webhook") so
    // one source recovering can't hide another source's — or the webhook's —
    // outage. Each entry is {message, at}.
    this.errors = {};
    this.sendSocketNotification("BIRDFY_CONFIG", this.config);
  },

  getStyles() {
    return ["font-awesome.css", "MMM-Birdfy.css"];
  },

  // The card carries its own title; only show MagicMirror's header when one is
  // configured explicitly (header: "..." on the module).
  getHeader() {
    return this.data.header || "";
  },

  // ─── DOM ─────────────────────────────────────────────────────────────────

  getDom() {
    const wrapper = document.createElement("div");

    if (this.alert) {
      wrapper.className = "birdfy-wrapper birdfy-card";
      this._renderAlert(wrapper);
      return wrapper;
    }

    // configError/configWarning/errors are diagnostic and shown even when
    // showWhenIdle is false; ordinary idle states respect it.
    const errorEntries = Object.entries(this.errors);
    const showDiagnostic = Boolean(this.configError || this.configWarning || errorEntries.length);
    if (!this.config.showWhenIdle && !showDiagnostic) {
      wrapper.className = "birdfy-wrapper";
      return wrapper;
    }

    wrapper.className = "birdfy-wrapper birdfy-card";

    if (this.configError) {
      wrapper.appendChild(this._buildIdleMessage(this.configError, "birdfy-idle-error"));
      return wrapper;
    }

    if (this.config.showWhenIdle) {
      if (!this.loaded) {
        wrapper.appendChild(this._buildIdleMessage("Watching for birds…"));
      } else if (this.invalidSources.length) {
        wrapper.appendChild(this._buildIdleMessage(`Birdfy link expired: ${this.invalidSources.join(", ")}`));
      } else if (this.todayVisitors.length) {
        wrapper.appendChild(this._buildTodayVisitors());
      } else {
        wrapper.appendChild(this._buildIdleMessage("No visitors yet today"));
      }
    }

    if (this.configWarning) {
      const warn = document.createElement("div");
      warn.className = "birdfy-error";
      warn.textContent = this.configWarning;
      wrapper.appendChild(warn);
    }

    // One line per unrecovered error source. The webhook's message is shown
    // verbatim (e.g. "Webhook port 8765 in use"); a Birdfy source's error is
    // prefixed with its source name so two failing sources are distinguishable.
    for (const [key, err] of errorEntries) {
      const line = document.createElement("div");
      line.className = "birdfy-error";
      line.textContent = key === "webhook"
        ? err.message
        : `${err.name || "Birdfy"} unreachable since ${this._formatTime(err.at)}`;
      wrapper.appendChild(line);
    }

    return wrapper;
  },

  // Idle-state row: an icon plus a short status line. `extraClass` adds a
  // modifier (e.g. "birdfy-idle-error") for states that need different styling.
  _buildIdleMessage(text, extraClass) {
    const idle = document.createElement("div");
    idle.className = extraClass ? `birdfy-idle ${extraClass}` : "birdfy-idle";

    const icon = document.createElement("i");
    icon.className = "fa fa-crow birdfy-icon";
    idle.appendChild(icon);

    const span = document.createElement("span");
    span.className = "birdfy-idle-text";
    span.textContent = text;
    idle.appendChild(span);

    return idle;
  },

  // ── Active alert ──────────────────────────────────────────────────────
  _renderAlert(wrapper) {
    const { species, deviceName, timestamp, videoUrl, imageUrl, streamUrl, isNewSpecies } = this.alert;

    const alertTitle = document.createElement("div");
    alertTitle.className = "birdfy-card-title";
    alertTitle.textContent = "Bird detected";
    wrapper.appendChild(alertTitle);

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

      // The name carries the nowrap/ellipsis truncation on its own; the
      // badge sits outside that span (flex: none) so a long name can't push
      // it out of view.
      const nameEl = document.createElement("span");
      nameEl.className = "birdfy-species-name";
      nameEl.textContent = species;
      speciesEl.appendChild(nameEl);

      if (isNewSpecies) {
        const badge = document.createElement("span");
        badge.className = "birdfy-new";
        badge.textContent = "New species";
        speciesEl.appendChild(badge);
      }
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
  },

  // Grid of today's identified species with Birdfy's photo of each.
  _buildTodayVisitors() {
    const box = document.createElement("div");
    box.className = "birdfy-today";

    const title = document.createElement("div");
    title.className = "birdfy-card-title";
    title.textContent = `Today's visitors (${this.todayVisitors.length})`;
    box.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "birdfy-today-grid";
    for (const v of this.todayVisitors.slice(0, this.config.maxVisitors)) {
      const item = document.createElement("div");
      item.className = "birdfy-visitor";
      if (v.imageUrl) {
        const img = document.createElement("img");
        img.className = "birdfy-visitor-img";
        img.src = v.imageUrl;
        img.alt = v.name;
        // A cover photo URL can 404 or expire; drop the image rather than
        // leaving a broken-image glyph in the all-day idle grid.
        img.onerror = () => img.remove();
        item.appendChild(img);
      }
      const name = document.createElement("div");
      name.className = "birdfy-visitor-name";
      name.textContent = v.name;
      item.appendChild(name);
      grid.appendChild(item);
    }
    box.appendChild(grid);
    return box;
  },

  _buildMediaElement(url, isStream) {
    if (isStream) {
      // Live stream — needs an MJPEG/still image URL; an RTMP/HLS URL will
      // simply fail to load and fall back to the info-only layout below.
      const img = document.createElement("img");
      img.className = "birdfy-media";
      img.src = url;
      img.alt = "Live bird feeder view";
      img.onerror = () => img.remove();
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
      // A signed clip URL can expire between detection and display; fall
      // back to the still image if we have one, otherwise drop the media
      // element entirely so the info-only layout applies.
      video.onerror = () => {
        const fallbackUrl = this.alert && this.alert.imageUrl;
        if (fallbackUrl) {
          const img = document.createElement("img");
          img.className = "birdfy-media";
          img.src = fallbackUrl;
          img.alt = "Bird detection";
          img.onerror = () => img.remove();
          video.replaceWith(img);
        } else {
          video.remove();
        }
      };
      return video;
    }

    const img = document.createElement("img");
    img.className = "birdfy-media";
    img.src = url;
    img.alt = "Bird detection";
    img.onerror = () => img.remove();
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

      case "BIRDFY_ERROR": {
        Log.error(`[MMM-Birdfy] ${payload.message}`);
        const key = payload.key || "unknown";
        // Keep the first-seen timestamp for this key: node_helper re-sends
        // an outage summary every 15 min, and without this an unrecovered
        // error's displayed "since HH:MM" would drift forward on every
        // summary instead of naming when the outage actually started.
        const at = this.errors[key]?.at ?? Date.now();
        this.errors[key] = { message: payload.message, name: payload.name, at };
        if (!this.alert) this.updateDom(this.config.animationSpeed);
        break;
      }

      case "BIRDFY_TODAY":
        this.todayVisitors = payload.visitors || [];
        if (!this.alert) this.updateDom(this.config.animationSpeed);
        break;

      case "BIRDFY_STATUS":
        if (Object.prototype.hasOwnProperty.call(payload, "invalidSources")) {
          this.invalidSources = payload.invalidSources || [];
        }
        if (Object.prototype.hasOwnProperty.call(payload, "configError")) {
          this.configError = payload.configError || null;
        }
        if (Object.prototype.hasOwnProperty.call(payload, "configWarning")) {
          this.configWarning = payload.configWarning || null;
        }
        // A key (a source's uuid, or "webhook"); only that origin's error is
        // cleared, so one source's success never hides another's outage.
        if (payload.lastErrorCleared) {
          delete this.errors[payload.lastErrorCleared];
        }
        if (!this.alert) this.updateDom(this.config.animationSpeed);
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
