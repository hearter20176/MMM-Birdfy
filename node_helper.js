/**
 * node_helper.js — MMM-Birdfy
 *
 * Handles two ways of receiving bird-detection events from Birdfy:
 *
 *  1. HIGHLIGHTS MODE – polls the Birdfy (Netvue) highlights feed for each
 *     configured source. Each source is identified by the share UUID from the
 *     Birdfy app, the same one the Home Assistant Birdfy integration uses.
 *     No account login is needed. Two kinds of events are surfaced:
 *       - species sightings: the first time an identified species appears in
 *         today's birdList (frequent; cover photo, no exact time or clip)
 *       - curated clips: dataList items Birdfy selects as highlights (a few
 *         per week; include the video clip and detection time)
 *
 *  2. WEBHOOK MODE    – starts a local Express server so that external services
 *     (IFTTT, Home Assistant, etc.) can POST bird-detection payloads directly.
 *     The server binds to `webhookHost` (default 127.0.0.1, i.e. localhost
 *     only) and, when `webhookToken` is configured, requires it as either an
 *     `Authorization: Bearer <token>` header or a `?token=<token>` query
 *     parameter.
 *
 * Endpoint: GET https://api2.nvts.co/moments/h5CuratedData
 *           ?uuid=<share uuid>&startTime=<ms>&endTime=<ms>
 * Response: { birdList: [{ name, coverKey }], dataList: [{ detectObject,
 *             title, category, createTime, fileUrl }], message? }
 * An unknown UUID returns HTTP 200 with an empty dataList, not an error.
 */

"use strict";

const crypto = require("node:crypto");
const NodeHelper = require("node_helper");
const Log = require("logger");
const express = require("express");

const HIGHLIGHTS_URL = "https://api2.nvts.co/moments/h5CuratedData";
const SUMMARY_URL = "https://api2.nvts.co/moments/h5CuratedSummary";
const ERROR_SUMMARY_MS = 15 * 60 * 1000;
// How often to re-check whether an empty source's UUID is still recognised.
const VALIDITY_CHECK_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30000;
// Config keys the module used to read; kept only to warn users to migrate.
const DEPRECATED_CONFIG_KEYS = ["apiEmail", "apiPassword", "deviceIds"];

/**
 * Fetch JSON from a URL with a timeout, throwing a plain Error on any
 * network failure, non-2xx status, or unexpected body shape.
 * @param {string} url The request URL.
 * @param {object} params Query parameters to append.
 * @returns {Promise<object>} The parsed JSON body.
 */
async function getJson (url, params) {
	const query = new URLSearchParams(params).toString();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	let res;
	try {
		res = await fetch(`${url}?${query}`, { signal: controller.signal });
	} catch (err) {
		if (err.name === "AbortError") throw new Error("Birdfy request timed out");
		throw new Error(`Birdfy request failed: ${err.message}`);
	} finally {
		clearTimeout(timer);
	}
	if (res.status === 401 || res.status === 403) {
		throw new Error(`Birdfy authentication failed (HTTP ${res.status})`);
	}
	if (!res.ok) {
		throw new Error(`Birdfy request failed (HTTP ${res.status})`);
	}
	let data;
	try {
		data = await res.json();
	} catch {
		throw new Error("Unexpected response from Birdfy API");
	}
	return data;
}

// ── Birdfy highlights client ──────────────────────────────────────────────

class BirdfyHighlights {
	constructor (source) {
		this.name = source.name || "Birdfy";
		this.uuid = source.uuid;
	}

	// Today's highlights (local midnight → end of day), as the HA integration does.
	async getToday () {
		const start = new Date();
		start.setHours(0, 0, 0, 0);
		const end = new Date(start.getTime() + (24 * 60 * 60 * 1000) - 1);
		const data = await getJson(HIGHLIGHTS_URL, {
			uuid: this.uuid,
			startTime: String(start.getTime()),
			endTime: String(end.getTime())
		});
		if (!data || typeof data !== "object") throw new Error("Unexpected response from Birdfy API");
		if (data.message) throw new Error(data.message);
		return data;
	}

	// Number of days with highlights since the start of the month ~2 months ago,
	// the same window the highlights web page asks for. 0 means Birdfy no longer
	// recognises this UUID (expired or revoked share link).
	async getRecentDayCount () {
		const d = new Date(Date.now() - (59 * 24 * 60 * 60 * 1000));
		const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
		const data = await getJson(SUMMARY_URL, { uuid: this.uuid, date });
		return Array.isArray(data?.dataList) ? data.dataList.length : 0;
	}
}

// ── Convert a highlight item into the alert shape the frontend renders ─────

/**
 * @param {object} item A dataList entry from the Birdfy highlights response.
 * @param {object} thumbnails Map of species name to cover photo URL.
 * @param {string} sourceName The configured name of the source.
 * @returns {object} The alert payload sent to the frontend.
 */
function toAlert (item, thumbnails, sourceName) {
	const species = item.detectObject || null;
	return {
		id: `${item.createTime}-${item.fileUrl || species || ""}`,
		species,
		deviceName: sourceName,
		timestamp: Number(item.createTime) || Date.now(),
		videoUrl: safeUrl(item.fileUrl),
		imageUrl: safeUrl(species && thumbnails[species]),
		streamUrl: null,
		isNewSpecies: item.category === "newBird"
	};
}

// ── Normalise a webhook payload into the same shape ─────────────────────────

/**
 * Only allow http(s) URLs through to the frontend; anything else (e.g.
 * `javascript:`, `file:`, malformed strings) is dropped rather than handed
 * to an <img>/<video> element.
 * @param {string|null|undefined} value The candidate URL.
 * @returns {string|null} The URL if it is safe to use, otherwise null.
 */
function safeUrl (value) {
	if (typeof value !== "string" || !value) return null;
	return (/^https?:\/\//i).test(value) ? value : null;
}

/**
 * Resolve a webhook alert timestamp. Accepts unix milliseconds, unix
 * seconds (converted to ms), or an ISO/date string; falls back to "now"
 * when nothing usable is present.
 * @param {number|string|null|undefined} timestamp A raw timestamp value (number or string).
 * @param {string|null|undefined} createdAt A fallback date string.
 * @returns {number} A unix-ms timestamp.
 */
function resolveTimestamp (timestamp, createdAt) {
	let t = Number(timestamp) || Date.parse(timestamp || createdAt);
	if (t && t < 1e12) t *= 1000;
	return Number.isFinite(t) && t > 0 ? t : Date.now();
}

/**
 * @param {object} raw The parsed JSON body posted to the webhook.
 * @param {string} deviceName The name to use when the payload has none.
 * @returns {object} The alert payload sent to the frontend.
 */
function normaliseAlert (raw, deviceName) {
	return {
		id: raw.id || raw.alertId || String(Date.now()),
		species: raw.species || raw.birdName || raw.label || null,
		deviceName: deviceName || raw.deviceName || raw.device_name || null,
		timestamp: resolveTimestamp(raw.timestamp, raw.created_at),
		videoUrl: safeUrl(raw.videoUrl || raw.video_url || raw.clip_url),
		imageUrl: safeUrl(raw.imageUrl || raw.image_url || raw.thumb_url || raw.thumbnailUrl),
		streamUrl: safeUrl(raw.streamUrl || raw.stream_url)
	};
}

// ── Webhook auth ─────────────────────────────────────────────────────────

/**
 * Extract the caller-supplied token from an `Authorization: Bearer <token>`
 * header, falling back to a `?token=` query parameter.
 * @param {object} req The Express request.
 * @returns {string|null} The provided token, or null if none was sent.
 */
function extractProvidedToken (req) {
	const header = req.get ? req.get("Authorization") : undefined;
	if (typeof header === "string" && header.startsWith("Bearer ")) {
		return header.slice(7);
	}
	if (req.query && typeof req.query.token === "string") {
		return req.query.token;
	}
	return null;
}

/**
 * Check a webhook request against the configured shared secret using a
 * constant-time comparison (cheap hardening against timing attacks, on top
 * of the localhost-by-default bind). When no token is configured, every
 * request is authorised (backward compatible).
 * @param {object} req The Express request.
 * @param {string} token The configured `webhookToken`, if any.
 * @returns {boolean} Whether the request is authorised.
 */
function isWebhookAuthorized (req, token) {
	if (!token) return true;
	const provided = extractProvidedToken(req);
	if (typeof provided !== "string" || !provided) return false;
	const tokenBuf = Buffer.from(token);
	const providedBuf = Buffer.from(provided);
	if (tokenBuf.length !== providedBuf.length) return false;
	return crypto.timingSafeEqual(tokenBuf, providedBuf);
}

// ── node_helper ──────────────────────────────────────────────────────────

module.exports = NodeHelper.create({
	start () {
		Log.log("[MMM-Birdfy] node_helper started");
		this.config = null;
		this.pollTimer = null;
		this.sources = [];
		// Per-source state, keyed by uuid, kept across config resends (e.g. a
		// browser reload) so alerts already seen today are not re-announced.
		this.sourceState = new Map();
		this.webhookApp = null;
		this.webhookServer = null;
	},

	// ── Receive config from the frontend ──────────────────────────────────

	socketNotificationReceived (notification, payload) {
		if (notification !== "BIRDFY_CONFIG") return;

		this.config = payload || {};

		const deprecatedKeys = DEPRECATED_CONFIG_KEYS.filter((key) => this.config[key] !== undefined && this.config[key] !== null && this.config[key] !== "");
		if (deprecatedKeys.length) {
			Log.warn(`[MMM-Birdfy] Config keys no longer used: ${deprecatedKeys.join(", ")}. Use "sources: [{ name, uuid }]" instead — see README "Migrating from apiEmail/apiPassword/deviceIds".`);
		}

		const sources = (this.config.sources || []).filter((s) => s && s.uuid);
		const webhookEnabled = !!this.config.webhookEnabled;

		// Shown on the mirror whenever the legacy keys are present and there is
		// nothing else to poll, even if the webhook is enabled — apiEmail/
		// apiPassword/deviceIds never configured the webhook either, so a user
		// who only has those keys set is not actually receiving alerts.
		const configWarning = (deprecatedKeys.length && !sources.length)
			? `${deprecatedKeys.join("/")} are no longer used — see the README migration notes.`
			: null;

		if (!sources.length && !webhookEnabled) {
			let message = "No Birdfy sources configured (set config.sources: [{ name, uuid }]) and the webhook is disabled.";
			if (configWarning) message += ` ${configWarning}`;
			this.sendSocketNotification("BIRDFY_STATUS", { configError: message, configWarning });
			this.sendSocketNotification("BIRDFY_READY", {});
			return;
		}

		this.sendSocketNotification("BIRDFY_STATUS", { configError: null, configWarning });

		if (webhookEnabled && !this.webhookServer) {
			this._startWebhookServer();
		}

		if (sources.length) {
			this._startPolling(sources).then(() => {
				this.sendSocketNotification("BIRDFY_READY", {});
			});
		} else {
			this.sendSocketNotification("BIRDFY_READY", {});
		}
	},

	// ── Highlights polling ─────────────────────────────────────────────────

	_startPolling (sources) {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.sources = sources.map((s) => {
			let src = this.sourceState.get(s.uuid);
			if (src) {
				src.api = new BirdfyHighlights(s);
			} else {
				src = {
					api: new BirdfyHighlights(s),
					seen: new Set(),
					errorCount: 0,
					lastErrorLog: 0,
					lastValidityCheck: 0,
					invalid: false,
					speciesDay: null, // local date the species set belongs to
					speciesSeen: new Set(), // identified species already announced today
					speciesPrimed: false, // first poll after startup only records species
					visitors: [] // identified species seen today, for the idle view
				};
				this.sourceState.set(s.uuid, src);
			}
			return src;
		});
		Log.log(`[MMM-Birdfy] Polling ${this.sources.length} Birdfy source(s) every ${this.config.pollInterval / 1000}s`);
		this.pollTimer = setInterval(() => this._pollAll(), this.config.pollInterval);
		return this._pollAll();
	},

	async _pollAll () {
		for (const src of this.sources) {
			await this._pollSource(src);
		}
	},

	async _pollSource (src) {
		let data;
		try {
			data = await src.api.getToday();
		} catch (err) {
			this._logSourceError(src, err);
			return;
		}
		if (src.errorCount > 0) {
			Log.log(`[MMM-Birdfy] ${src.api.name}: recovered after ${src.errorCount} failed poll(s)`);
			src.errorCount = 0;
		}
		// Keyed by this source's uuid only: a healthy source must never clear
		// another source's (or the webhook's) error.
		this.sendSocketNotification("BIRDFY_STATUS", { lastErrorCleared: src.api.uuid });

		const items = Array.isArray(data.dataList) ? data.dataList : [];
		const thumbnails = {};
		for (const bird of data.birdList || []) {
			if (bird && bird.name && bird.coverKey) thumbnails[bird.name] = bird.coverKey;
		}

		this._announceNewSpecies(src, data.birdList || []);
		src.visitors = (data.birdList || [])
			.filter((b) => b && b.name && b.name.toLowerCase() !== "bird")
			.map((b) => ({ name: b.name, imageUrl: safeUrl(b.coverKey) }));
		this._sendToday();

		if (items.length || (data.birdList || []).length) {
			this._setInvalid(src, false);
		} else if (Date.now() - src.lastValidityCheck > VALIDITY_CHECK_MS) {
			src.lastValidityCheck = Date.now();
			try {
				this._setInvalid(src, (await src.api.getRecentDayCount()) === 0);
			} catch (err) {
				this._logSourceError(src, err);
			}
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

	// Send the identified species seen today (all sources, de-duplicated) so the
	// frontend can show them between alerts, like HA's species list / last bird.
	_sendToday () {
		const seen = new Set();
		const visitors = [];
		for (const src of this.sources) {
			for (const v of src.visitors || []) {
				if (seen.has(v.name)) continue;
				seen.add(v.name);
				visitors.push({ ...v, source: src.api.name });
			}
		}
		this.sendSocketNotification("BIRDFY_TODAY", { visitors });
	},

	// Alert the first time each identified species shows up in today's birdList.
	// "bird" is Birdfy's label for an unidentified bird and is skipped, as with clips.
	_announceNewSpecies (src, birdList) {
		const d = new Date();
		const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
		if (src.speciesDay !== today) {
			src.speciesDay = today;
			src.speciesSeen = new Set();
		}
		for (const bird of birdList) {
			const name = bird && bird.name;
			if (!name || name.toLowerCase() === "bird" || src.speciesSeen.has(name)) continue;
			src.speciesSeen.add(name);
			if (!src.speciesPrimed) continue;
			this.sendSocketNotification("BIRDFY_ALERT", {
				id: `species-${today}-${name}`,
				species: name,
				deviceName: src.api.name,
				timestamp: Date.now(),
				videoUrl: null,
				imageUrl: safeUrl(bird.coverKey),
				streamUrl: null,
				isNewSpecies: false
			});
		}
		src.speciesPrimed = true;
	},

	// Track sources whose share UUID Birdfy no longer recognises and tell the frontend.
	_setInvalid (src, invalid) {
		if (src.invalid === invalid) return;
		src.invalid = invalid;
		if (invalid) {
			Log.warn(`[MMM-Birdfy] ${src.api.name}: Birdfy has no highlights for this share UUID in ~2 months; ` +
				"the link has likely expired. Get a new one in the Birdfy app (profile > Highlights, copy the uuid= value).");
		} else {
			Log.log(`[MMM-Birdfy] ${src.api.name}: highlights available again`);
		}
		this.sendSocketNotification("BIRDFY_STATUS", {
			invalidSources: this.sources.filter((s) => s.invalid).map((s) => s.api.name)
		});
	},

	// Log the first failure of an outage, then a summary at most every 15 minutes.
	_logSourceError (src, err) {
		src.errorCount += 1;
		const now = Date.now();
		if (src.errorCount === 1 || now - src.lastErrorLog >= ERROR_SUMMARY_MS) {
			const suffix = src.errorCount > 1 ? ` (${src.errorCount} failed polls so far)` : "";
			this._sendError(`${src.api.name}: ${err.message}${suffix}`, src.api.uuid, src.api.name);
			src.lastErrorLog = now;
		}
	},

	// ── Webhook server ──────────────────────────────────────────────────────

	_startWebhookServer () {
		this.webhookApp = express();

		const path = this.config.webhookPath || "/birdfy";
		const token = this.config.webhookToken || "";

		// Auth runs before body parsing: an unauthenticated caller must never
		// reach express.json() (and its default error handler / stack trace)
		// at all, regardless of what they post.
		this.webhookApp.use(path, (req, res, next) => {
			// Never log the request body — it may contain signed media URLs.
			const size = req.get("content-length") || "unknown";
			const type = req.get("content-type") || "unknown";
			Log.log(`[MMM-Birdfy] Webhook ${req.method} received (${size} bytes, ${type})`);

			if (!isWebhookAuthorized(req, token)) {
				res.status(401).json({ error: "unauthorized" });
				return;
			}
			next();
		});
		this.webhookApp.use(path, express.json());

		this.webhookApp.post(path, (req, res) => {
			try {
				const alert = normaliseAlert(req.body || {}, req.body && req.body.deviceName);
				if (!alert.species) {
					res.status(200).json({ ok: true, skipped: "no species identified" });
					return;
				}
				this.sendSocketNotification("BIRDFY_ALERT", alert);
				res.status(200).json({ ok: true });
			} catch (err) {
				Log.error(`[MMM-Birdfy] Webhook handler error: ${err.message}`);
				res.status(400).json({ error: "invalid request" });
			}
		});

		// Health-check endpoint; auth already applied above.
		this.webhookApp.get(path, (req, res) => {
			res.json({ module: "MMM-Birdfy", status: "ok" });
		});

		// Malformed or oversized bodies land here via express.json() (a
		// SyntaxError, or body-parser's "entity.too.large"). Answer with a
		// plain, stack-free response and log only the message (never the
		// default Express handler, which would write an HTML stack trace,
		// including absolute file paths, to both the response and stderr).
		// Express only recognises this as error-handling middleware because it
		// declares all 4 parameters, even though `next` is unused here.
		this.webhookApp.use((err, req, res, next) => {
			Log.error(`[MMM-Birdfy] Webhook JSON parse error: ${err.message}`);
			if (err.type === "entity.too.large") {
				res.status(413).json({ error: "payload too large" });
				return;
			}
			res.status(400).json({ error: "invalid JSON" });
		});

		// Nullish, not ||: webhookPort: 0 is a valid "let the OS pick a free
		// port" request (used by the test suite) and must not be coerced to
		// the default.
		const port = this.config.webhookPort ?? 8765;
		const host = this.config.webhookHost || "127.0.0.1";

		// Deliberately not passing a callback to listen(): Express 5's
		// app.listen() wraps a trailing function argument with
		// `server.once("error", done)` in *addition* to the normal
		// "listening" registration, so that callback would also fire (with
		// the server unbound, address() === null) on a failed bind. Using
		// separate "listening"/"error" listeners avoids that footgun.
		this.webhookServer = this.webhookApp.listen(port, host);
		this.webhookServer.on("listening", () => {
			Log.log(`[MMM-Birdfy] Webhook server listening on ${host}:${this.webhookServer.address().port}${path}`);
		});
		this.webhookServer.on("error", (err) => {
			this.webhookServer = null;
			const message = err.code === "EADDRINUSE"
				? `Webhook port ${port} in use`
				: `Webhook could not listen on ${host}:${port}: ${err.code || err.message}`;
			this._sendError(message, "webhook");
		});
	},

	// ── Helpers ───────────────────────────────────────────────────────────

	// `key` identifies the origin: a source's uuid, or "webhook". Keeping
	// errors keyed lets the frontend show/clear each independently instead of
	// one source's recovery hiding another's outage. `name` (a source's
	// configured name) lets the frontend label which source is failing when
	// more than one is unreachable at once.
	_sendError (message, key, name) {
		Log.error(`[MMM-Birdfy] ${message}`);
		this.sendSocketNotification("BIRDFY_ERROR", { message, key, name });
	},

	// Clean up when MagicMirror stops
	stop () {
		clearInterval(this.pollTimer);
		if (this.webhookServer) this.webhookServer.close();
	},

	// Exposed only so the test suite can exercise pure helpers directly.
	_testables: {
		toAlert,
		normaliseAlert,
		safeUrl,
		resolveTimestamp,
		isWebhookAuthorized
	}
});
