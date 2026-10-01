Module.register("MMM-Birdfy", {
  defaults: {
    // --- Home Assistant mode (recommended; handled by node_helper) ---
    // "homeassistant", or leave empty to keep the polling/webhook behaviour.
    source: "",
    haUrl: "",
    // Long-lived access token. Read by node_helper only: this front end never
    // renders or logs it.
    haToken: "",
    // [{ name, speciesEntity, imageEntity }]; auto-discovered when omitted
    feeders: [],

    // --- Birdfy highlights (polling mode) ---
    // Feeds to poll: [{ name: "Bird Feeder", uuid: "<share uuid>" }]
    sources: [],
    // How often to poll for new bird sightings (ms)
    pollInterval: 2 * 60 * 1000,
    // Only surface alerts newer than this age (ms)
    // null = let node_helper pick per mode (30 min cloud, 60 min Home Assistant)
    maxAlertAge: null,

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
    // How long to show the bird alert before returning to idle (ms), counted
    // from when the module is first visible (it may sit on a hidden page)
    displayDuration: 60 * 1000,
    // Card width in px (alert and idle views)
    cardWidth: 560,
    // CSS aspect-ratio of the captured image (Birdfy covers are square)
    imageAspect: "1/1",
    // Jump to the page holding this module when a fresh alert arrives: sends
    // PAGE_CHANGED with `alertPage`, then PAUSE_ROTATION, and RESUME_ROTATION
    // after displayDuration (wall clock) so the page cannot rotate away
    pageOnAlert: false,
    // MMM-pages page index of this module (0-based); required for pageOnAlert
    alertPage: null,
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
    this.todayTotal = null;    // total highlight visits today, all birds
    this.lastAlertId = null;   // id of the last alert shown (de-dupe on resend)
    this.haConnected = null;   // HA websocket state, when reported
    this.haRetrying = true;    // false once HA reports no further reconnect attempts
    this.haError = null;       // {kind, message, since, terminal} from node_helper
    this.todayCountSource = null; // "highlights" | "detections" | "mixed"
    this.suspended = false;    // true while the module's page is hidden
    this.alertRemaining = 0;   // ms of displayDuration still to show
    this.alertDeadline = 0;    // wall-clock end of the running countdown
    this.rotationPaused = false; // true while we hold MMM-pages' rotation paused
    this.rotationTimer = null;   // wall-clock timer that releases the pause
    this.rotationArrived = false; // our page has been shown since we paused
    this.configError = null;   // e.g. no sources configured and webhook disabled
    this.configWarning = null; // e.g. deprecated config keys present but unused
    // Unrecovered errors keyed by origin (a source's uuid, or "webhook") so
    // one source recovering can't hide another source's — or the webhook's —
    // outage. Each entry is {message, at}.
    this.errors = {};
    if (this.config.pageOnAlert && !(Number.isInteger(this.config.alertPage) && this.config.alertPage >= 0)) {
      Log.warn("[MMM-Birdfy] pageOnAlert is on but alertPage is not a page number; it will not switch pages");
    }
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
    try {
      this._render(wrapper);
    } catch (err) {
      // A malformed payload must never take the whole mirror's render down.
      Log.error(`[MMM-Birdfy] Render failed: ${err && err.message}`);
      wrapper.className = "birdfy-wrapper birdfy-card";
      this._applyCardSize(wrapper);
      wrapper.appendChild(this._buildIdleMessage("Birdfy display error"));
    }
    return wrapper;
  },

  _render(wrapper) {
    if (this.alert) {
      wrapper.className = "birdfy-wrapper birdfy-card birdfy-card-alert";
      this._applyCardSize(wrapper);
      this._renderAlert(wrapper);
      return;
    }

    // configError/configWarning/errors are diagnostic and shown even when
    // showWhenIdle is false; ordinary idle states respect it.
    const errorEntries = Object.entries(this.errors);
    const haDown = this.haConnected === false;
    const showDiagnostic = Boolean(this.configError || this.configWarning || errorEntries.length || haDown || this.haError);
    if (!this.config.showWhenIdle && !showDiagnostic) {
      wrapper.className = "birdfy-wrapper";
      return;
    }

    wrapper.className = "birdfy-wrapper birdfy-card";
    this._applyCardSize(wrapper);

    if (this.configError) {
      wrapper.appendChild(this._buildIdleMessage(this.configError, "birdfy-idle-error"));
      return;
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

    // A specific HA error (bad token, no sensors, connection) is shown with
    // its own message. The generic disconnect line only appears without one,
    // and only promises a reconnect when node_helper is actually retrying.
    if (this.haError && this.haError.message) {
      const line = document.createElement("div");
      line.className = "birdfy-error";
      line.textContent = this.haError.message;
      wrapper.appendChild(line);
    } else if (haDown) {
      const line = document.createElement("div");
      line.className = "birdfy-error";
      line.textContent = this.haRetrying
        ? "Home Assistant disconnected, reconnecting…"
        : "Home Assistant disconnected";
      wrapper.appendChild(line);
    }

    // One line per unrecovered error source. The webhook's message is shown
    // verbatim (e.g. "Webhook port 8765 in use"); a Birdfy source's error is
    // prefixed with its source name so two failing sources are distinguishable.
    for (const [key, err] of errorEntries) {
      const line = document.createElement("div");
      line.className = "birdfy-error";
      // Webhook and Home Assistant messages are specific and shown verbatim.
      line.textContent = (key === "webhook" || key.startsWith("homeassistant"))
        ? err.message
        : `${err.name || "Birdfy"} unreachable since ${this._formatTime(err.at)}`;
      wrapper.appendChild(line);
    }
  },

  // Card width comes from config; CSS max-width: 100% keeps it inside the region.
  _applyCardSize(el) {
    const width = Number(this.config.cardWidth);
    el.style.width = `${Number.isFinite(width) && width > 0 ? width : 560}px`;
  },

  // Valid CSS aspect-ratio ("1/1", "16/10", "1.6"); anything else falls back.
  _imageAspect() {
    const aspect = String(this.config.imageAspect || "").trim();
    return /^\d+(\.\d+)?(\s*\/\s*\d+(\.\d+)?)?$/.test(aspect) ? aspect : "1/1";
  },

  // Where the counts came from, worded the same on the alert and idle views.
  _countNote(source) {
    if (source === "detections") return "Counts from detections seen by this mirror";
    if (source === "mixed") return "Counts from Birdfy highlights and detections seen by this mirror";
    return "Counts from Birdfy highlights";
  },

  _plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
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

  // Stand-in shown when an image or clip is missing or fails to load. Fills
  // its parent, so the frame keeps its aspect ratio and the card does not jump.
  _buildMediaFallback() {
    const fallback = document.createElement("div");
    fallback.className = "birdfy-media-fallback";
    const icon = document.createElement("i");
    icon.className = "fa fa-crow";
    fallback.appendChild(icon);
    return fallback;
  },

  // "N visits today" / "M total visits today" line: big number plus a label.
  _buildStat(value, label, extraClass) {
    const stat = document.createElement("div");
    stat.className = extraClass ? `birdfy-stat ${extraClass}` : "birdfy-stat";
    const num = document.createElement("span");
    num.className = "birdfy-stat-value";
    num.textContent = String(value);
    stat.appendChild(num);
    const text = document.createElement("span");
    text.className = "birdfy-stat-label";
    text.textContent = label;
    stat.appendChild(text);
    return stat;
  },

  // ── Active alert ──────────────────────────────────────────────────────
  _renderAlert(wrapper) {
    const { species, feeder, deviceName, timestamp, videoUrl, imageUrl, streamUrl, isNewSpecies,
      speciesVisitsToday, totalVisitsToday, countSource } = this.alert;

    const alertTitle = document.createElement("div");
    alertTitle.className = "birdfy-card-title";
    alertTitle.textContent = "Bird detected";
    wrapper.appendChild(alertTitle);

    // Media (video, live stream, or still): fills the card width
    const frame = document.createElement("div");
    frame.className = "birdfy-media-frame";
    frame.style.aspectRatio = this._imageAspect();

    const useStream = Boolean(this.config.showLiveView && streamUrl);
    const mediaUrl = useStream
      ? streamUrl
      : (this.config.showVideo && videoUrl ? videoUrl : imageUrl);
    frame.appendChild(mediaUrl ? this._buildMediaElement(mediaUrl, useStream) : this._buildMediaFallback());
    wrapper.appendChild(frame);

    // Species name, prominent
    if (species) {
      const speciesEl = document.createElement("div");
      speciesEl.className = "birdfy-species";

      // The badge sits outside the name span (flex: none) so a long name
      // wraps instead of pushing it out of view.
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
      wrapper.appendChild(speciesEl);
    }

    // Visit counts (omitted when the source did not supply them)
    const hasSpeciesCount = Number.isFinite(speciesVisitsToday);
    const hasTotal = Number.isFinite(totalVisitsToday);
    if (hasSpeciesCount || hasTotal) {
      const stats = document.createElement("div");
      stats.className = "birdfy-stats";
      if (hasSpeciesCount) {
        stats.appendChild(this._buildStat(speciesVisitsToday, speciesVisitsToday === 1 ? "visit today" : "visits today"));
      }
      if (hasTotal) {
        stats.appendChild(this._buildStat(totalVisitsToday, totalVisitsToday === 1 ? "total visit today" : "total visits today", "birdfy-stat-total"));
      }
      wrapper.appendChild(stats);

      const note = document.createElement("div");
      note.className = "birdfy-note";
      note.textContent = this._countNote(countSource);
      wrapper.appendChild(note);
    }

    const meta = document.createElement("div");
    meta.className = "birdfy-meta";
    const parts = [];
    if (feeder || deviceName) parts.push(feeder || deviceName);
    if (timestamp)  parts.push(this._formatTime(timestamp));
    meta.textContent = parts.join(" · ");
    wrapper.appendChild(meta);
  },

  // Today's identified species with Birdfy's photo, visit count and totals.
  _buildTodayVisitors() {
    const box = document.createElement("div");
    box.className = "birdfy-today";

    const head = document.createElement("div");
    head.className = "birdfy-today-head";

    const title = document.createElement("div");
    title.className = "birdfy-card-title";
    title.textContent = `Today's visitors (${this.todayVisitors.length})`;
    head.appendChild(title);

    const total = this._todayTotal();
    if (total !== null) {
      const totalEl = document.createElement("div");
      totalEl.className = "birdfy-today-total";
      totalEl.textContent = `${total} total ${total === 1 ? "visit" : "visits"} today`;
      head.appendChild(totalEl);
    }
    box.appendChild(head);

    const list = document.createElement("div");
    list.className = "birdfy-today-list";
    const max = Math.max(0, Number(this.config.maxVisitors) || 0);
    for (const v of this.todayVisitors.slice(0, max)) {
      const row = document.createElement("div");
      row.className = "birdfy-visitor";

      const thumb = document.createElement("div");
      thumb.className = "birdfy-visitor-thumb";
      if (v.imageUrl) {
        const img = document.createElement("img");
        img.className = "birdfy-visitor-img";
        img.src = v.imageUrl;
        img.alt = v.name;
        // A photo URL can 404 or expire; swap in the placeholder rather than
        // leaving a broken-image glyph in the all-day idle view.
        img.onerror = () => img.replaceWith(this._buildMediaFallback());
        thumb.appendChild(img);
      } else {
        thumb.appendChild(this._buildMediaFallback());
      }
      row.appendChild(thumb);

      const name = document.createElement("div");
      name.className = "birdfy-visitor-name";
      name.textContent = v.name;
      row.appendChild(name);

      if (Number.isFinite(v.count)) {
        const count = document.createElement("div");
        count.className = "birdfy-visitor-count";
        count.textContent = this._plural(v.count, "visit", "visits");
        row.appendChild(count);
      }
      list.appendChild(row);
    }
    box.appendChild(list);

    const hidden = this.todayVisitors.length - max;
    if (hidden > 0) {
      const more = document.createElement("div");
      more.className = "birdfy-more";
      more.textContent = `+${hidden} more`;
      box.appendChild(more);
    }

    // Only explain the counts when some are shown
    if (total !== null || this.todayVisitors.some((v) => Number.isFinite(v.count))) {
      const note = document.createElement("div");
      note.className = "birdfy-note";
      note.textContent = this._countNote(this.todayCountSource);
      box.appendChild(note);
    }
    return box;
  },

  // Total visits today: the helper's figure, else the sum of per-species
  // counts when every species has one, else unknown (null).
  _todayTotal() {
    if (Number.isFinite(this.todayTotal)) return this.todayTotal;
    if (this.todayVisitors.length && this.todayVisitors.every((v) => Number.isFinite(v.count))) {
      return this.todayVisitors.reduce((sum, v) => sum + v.count, 0);
    }
    return null;
  },

  _buildImage(url, alt, fallbackUrl) {
    const img = document.createElement("img");
    img.className = "birdfy-media";
    img.src = url;
    img.alt = alt;
    // Chain to the still (if any), then to the placeholder.
    img.onerror = () => {
      if (fallbackUrl && fallbackUrl !== url) {
        img.onerror = () => img.replaceWith(this._buildMediaFallback());
        img.src = fallbackUrl;
      } else {
        img.replaceWith(this._buildMediaFallback());
      }
    };
    return img;
  },

  _buildMediaElement(url, isStream) {
    const stillUrl = this.alert && this.alert.imageUrl;
    if (isStream) {
      // Live stream: needs an MJPEG/still image URL; an RTMP/HLS URL will
      // simply fail to load and fall back to the still or placeholder.
      return this._buildImage(url, "Live bird feeder view", stillUrl);
    }

    if (/\.(mp4|webm|mov)/i.test(url)) {
      const video = document.createElement("video");
      video.className = "birdfy-media";
      video.src = url;
      if (stillUrl) video.poster = stillUrl;
      video.autoplay = true;
      video.muted = true;
      video.loop = false;
      video.controls = false;
      video.playsInline = true;
      // A signed clip URL can expire between detection and display; fall
      // back to the still image, then to the placeholder.
      video.onerror = () => {
        video.replaceWith(stillUrl
          ? this._buildImage(stillUrl, "Bird detection")
          : this._buildMediaFallback());
      };
      return video;
    }

    return this._buildImage(url, "Bird detection");
  },

  _formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  },

  // ─── Socket notifications (from node_helper) ─────────────────────────────

  socketNotificationReceived(notification, payload) {
    payload = payload || {};
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
        this.todayVisitors = Array.isArray(payload.visitors) ? payload.visitors : [];
        this.todayTotal = Number.isFinite(payload.totalVisitsToday) ? payload.totalVisitsToday : null;
        this.todayCountSource = payload.countSource || null;
        this.loaded = true;
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
        if (Object.prototype.hasOwnProperty.call(payload, "connected")) {
          // Only the HA source reports a live connection state.
          this.haConnected = payload.source === "homeassistant" ? Boolean(payload.connected) : null;
          // retrying:false means a terminal failure (e.g. rejected token)
          this.haRetrying = payload.retrying !== false;
          if (payload.connected && !Object.prototype.hasOwnProperty.call(payload, "haError")) {
            this.haError = null;
          }
        }
        if (Object.prototype.hasOwnProperty.call(payload, "haError")) {
          this.haError = payload.haError || null;
          if (this.haError && this.haError.terminal) this.haRetrying = false;
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
    // node_helper may re-send an alert (config resend, reconnect); never
    // re-announce one we have already shown.
    if (alertData.id && alertData.id === this.lastAlertId) return;
    if (alertData.id) this.lastAlertId = alertData.id;

    Log.info(`[MMM-Birdfy] Bird detected: ${alertData.species || "unknown"}`);

    // Clear any existing countdown
    this._clearAlertTimer();

    this.alert = alertData;
    this.loaded = true;
    this.alertRemaining = this._displayDuration();
    this.updateDom(this.config.animationSpeed);

    // The countdown starts once the module is visible: immediately on a
    // visible page, otherwise at resume() when its page rotates in.
    if (!this.suspended) this._startAlertTimer();

    if (this._shouldJump(alertData)) this._holdPage();
  },

  _maxAlertAgeMs() {
    const ms = Number(this.config.maxAlertAge);
    if (Number.isFinite(ms) && ms > 0) return ms;
    return this.config.source === "homeassistant" ? 60 * 60 * 1000 : 30 * 60 * 1000;
  },

  // Jump only for a live, fresh alert: not one older than maxAlertAge, and
  // not one node_helper marks as a startup/priming replay.
  _shouldJump(alertData) {
    if (!this.config.pageOnAlert) return false;
    if (!(Number.isInteger(this.config.alertPage) && this.config.alertPage >= 0)) return false;
    if (alertData.priming === true || alertData.replay === true) return false;
    if (Number.isFinite(alertData.timestamp) && Date.now() - alertData.timestamp > this._maxAlertAgeMs()) return false;
    return true;
  },

  // Go to our MMM-pages page and keep rotation paused until displayDuration
  // has passed on the wall clock. PAUSE_ROTATION follows every PAGE_CHANGED:
  // MMM-pages restarts a paused rotation timer on PAGE_CHANGED, so without it a
  // second alert during a hold would let the page rotate away early. (Pausing
  // an already-paused MMM-pages is harmless.) There is one release timer; a
  // newer alert restarts it.
  _holdPage() {
    this.sendNotification("PAGE_CHANGED", this.config.alertPage);
    this.sendNotification("PAUSE_ROTATION");
    if (!this.rotationPaused) {
      this.rotationPaused = true;
      // "Arrived" is set by resume() only. MagicMirror's show() runs resume()
      // after every PAGE_CHANGED, including when our page is already visible.
      this.rotationArrived = false;
    }
    if (this.rotationTimer) clearTimeout(this.rotationTimer);
    this.rotationTimer = setTimeout(() => this._releaseRotation(), this._displayDuration());
  },

  // Resume MMM-pages rotation if (and only if) we paused it. Safe to call
  // repeatedly: the second call does nothing.
  _releaseRotation() {
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    if (!this.rotationPaused) return;
    this.rotationPaused = false;
    this.rotationArrived = false;
    this.sendNotification("RESUME_ROTATION");
  },

  _displayDuration() {
    const ms = Number(this.config.displayDuration);
    return Number.isFinite(ms) && ms > 0 ? ms : 60 * 1000;
  },

  _startAlertTimer() {
    if (!this.alert || this.hideTimer) return;
    if (this.alertRemaining <= 0) {
      this._dismissAlert();
      return;
    }
    this.alertDeadline = Date.now() + this.alertRemaining;
    this.hideTimer = setTimeout(() => this._dismissAlert(), this.alertRemaining);
  },

  _clearAlertTimer() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  },

  _dismissAlert() {
    this._releaseRotation();
    this._clearAlertTimer();
    this.alert = null;
    this.alertRemaining = 0;
    this.updateDom(this.config.animationSpeed);
  },

  // MagicMirror calls suspend()/resume() when MMM-pages hides/shows the
  // module. Pause the countdown while hidden so the alert gets its full
  // displayDuration of actual screen time.
  suspend() {
    this.suspended = true;
    // Our page was shown and has now been left by someone else (manual
    // navigation): do not leave the whole mirror stuck paused on another page.
    if (this.rotationPaused && this.rotationArrived) this._releaseRotation();
    if (this.hideTimer) {
      this.alertRemaining = Math.max(0, this.alertDeadline - Date.now());
      this._clearAlertTimer();
    }
  },

  resume() {
    this.suspended = false;
    if (this.rotationPaused) this.rotationArrived = true;
    if (this.alert) {
      this._startAlertTimer();
      // Re-render so a clip restarts when its page comes back around.
      if (this.alert) this.updateDom(0);
    }
  },

  // MagicMirror does not call this on browser modules today, but if it does
  // (or a test tears the module down) never leave rotation paused.
  stop() {
    this._clearAlertTimer();
    this._releaseRotation();
  },

  // ─── Broadcast to other modules ───────────────────────────────────────────

  notificationReceived(notification, payload) {
    // Allow other modules or the config to trigger a demo alert
    if (notification === "BIRDFY_DEMO") {
      this._showAlert({
        species: payload?.species || "House Sparrow",
        feeder: payload?.feeder || payload?.deviceName || "Garden Feeder",
        timestamp: Date.now(),
        imageUrl: payload?.imageUrl || null,
        videoUrl: payload?.videoUrl || null,
        streamUrl: payload?.streamUrl || null,
        speciesVisitsToday: payload?.speciesVisitsToday ?? 3,
        totalVisitsToday: payload?.totalVisitsToday ?? 12,
        countSource: "highlights",
      });
    }
  },
});
