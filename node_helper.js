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
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const nodePath = require("node:path");
const NodeHelper = require("node_helper");
const Log = require("logger");
const express = require("express");
const WebSocket = require("ws");

const HIGHLIGHTS_URL = "https://api2.nvts.co/moments/h5CuratedData";
const SUMMARY_URL = "https://api2.nvts.co/moments/h5CuratedSummary";
const ERROR_SUMMARY_MS = 15 * 60 * 1000;
// How often to re-check whether an empty source's UUID is still recognised.
const VALIDITY_CHECK_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30000;
// Config keys the module used to read; kept only to warn users to migrate.
const DEPRECATED_CONFIG_KEYS = ["apiEmail", "apiPassword", "deviceIds"];

// Home Assistant mode.
const GENERIC_SPECIES = "bird";
const HA_DEFAULT_MAX_ALERT_AGE_MS = 60 * 60 * 1000;
const CLOUD_DEFAULT_MAX_ALERT_AGE_MS = 30 * 60 * 1000;
const HA_TOKEN_ENV = "BIRDFY_HA_TOKEN";
// The only image types the proxy passes through (no SVG or anything scriptable).
const PROXY_IMAGE_TYPES = (/^image\/(jpeg|png|webp|gif)(\s*;.*)?$/i);
const HA_DEFAULT_HEARTBEAT_MS = 30000;
const HA_RECONNECT_MIN_MS = 5000;
const HA_RECONNECT_MAX_MS = 60000;
// Consecutive failed connection attempts before the front end is told.
const HA_ERROR_AFTER_FAILURES = 3;
const HA_DEFAULT_DEBOUNCE_MS = 250;
// The HA image entity "ticks" on every HA restart; ignore ticks this soon after connecting.
const HA_IMAGE_SETTLE_MS = 60000;
const IMAGE_PROXY_PATH = "/birdfy/image/:feederIndex";
const IMAGE_PROXY_TIMEOUT_MS = 15000;
const IMAGE_PROXY_MAX_BYTES = 8 * 1024 * 1024;
const STATE_FILE = "birdfy-state.json";

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

// ── Home Assistant helpers ───────────────────────────────────────────────

/**
 * Normalise a species name; null for empty values and for Birdfy's generic
 * "bird" label (an unidentified bird), which is never announced or counted.
 * @param {*} value A raw species value.
 * @returns {string|null} The trimmed species name, or null to ignore it.
 */
function cleanSpecies (value) {
	if (typeof value !== "string") return null;
	const name = value.trim();
	if (!name || name.toLowerCase() === GENERIC_SPECIES) return null;
	return name;
}

/**
 * HA hands list/dict attributes over as JSON values; some views show them as
 * JSON strings. Accept both.
 * @param {*} value A raw attribute value.
 * @returns {*} The decoded value, or null when a string is not valid JSON.
 */
function parseJsonAttr (value) {
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return null;
		}
	}
	return value === undefined ? null : value;
}

/**
 * @param {*} value A raw attribute value.
 * @returns {Array} The value as an array ([] when it is not one).
 */
function parseList (value) {
	const parsed = parseJsonAttr(value);
	return Array.isArray(parsed) ? parsed : [];
}

/**
 * @param {*} value A raw attribute value.
 * @returns {object} The value as a plain object ({} when it is not one).
 */
function parseObject (value) {
	const parsed = parseJsonAttr(value);
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

/**
 * @param {number} ms A unix-ms timestamp.
 * @returns {string} The local calendar date as YYYY-MM-DD.
 */
function localDateString (ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * @param {number} ms A unix-ms timestamp.
 * @returns {number} Unix-ms of local midnight at the start of that timestamp's day.
 */
function startOfLocalDay (ms) {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/**
 * Parse a naive local ISO timestamp as the integration writes them
 * (e.g. 2026-09-30T11:26:00 or ...59.999000).
 * @param {*} value The raw attribute value.
 * @returns {number|null} Unix-ms, or null when unparseable.
 */
function parseLocalIso (value) {
	if (typeof value !== "string" || !value) return null;
	const t = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
	return Number.isFinite(t) ? t : null;
}

/**
 * @param {string} text Text to fingerprint.
 * @returns {string} A short stable hash, used to build compact alert ids.
 */
function shortHash (text) {
	return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * Is a Birdfy state usable (HA reports "unavailable"/"unknown" while the
 * integration is loading)?
 * @param {object|undefined} st An HA state object.
 * @returns {boolean} True when the state carries data.
 */
function isUsableState (st) {
	return !!st && st.state !== "unavailable" && st.state !== "unknown";
}

/**
 * Validate and normalise haUrl.
 * @param {*} value The configured haUrl.
 * @returns {string|null} The base URL without trailing slashes, or null if invalid.
 */
function normaliseHaUrl (value) {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const u = new URL(value.trim());
		if (u.protocol !== "http:" && u.protocol !== "https:") return null;
		return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
	} catch {
		return null;
	}
}

/**
 * Derive the "stem" of a *_bird_species entity id (without domain/suffix).
 * @param {string} entityId e.g. sensor.birdfy_bird_feeder_bird_species.
 * @returns {string|null} e.g. birdfy_bird_feeder, or null when it is not a species sensor.
 */
function speciesStem (entityId) {
	// sensor.<stem>_last_bird_species is a sibling sensor, not a feeder.
	const m = (/^sensor\.(.+)_bird_species$/).exec(entityId || "");
	return m && !m[1].endsWith("_last") ? m[1] : null;
}

/**
 * Pick a display name for an auto-discovered feeder.
 * @param {object} state The HA state of the species sensor.
 * @param {string} stem The entity stem.
 * @returns {string} A short feeder name.
 */
function discoveredName (state, stem) {
	const friendly = state && state.attributes && state.attributes.friendly_name;
	if (typeof friendly === "string") {
		const trimmed = friendly.replace(/\s*Bird Species$/i, "").replace(/^Birdfy\s+/i, "").trim();
		if (trimmed) return trimmed;
	}
	return stem.replace(/_/g, " ");
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
		this._haInit();
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

		if (this.config.source === "homeassistant") {
			this._configureHomeAssistant(sources, webhookEnabled);
			return;
		}
		// Leaving Home Assistant mode (config changed and the front end reloaded).
		this._haShutdown();

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
			this.sendSocketNotification("BIRDFY_STATUS", { configError: message, configWarning, source: sources.length ? "cloud" : "webhook" });
			this.sendSocketNotification("BIRDFY_READY", {});
			return;
		}

		this.sendSocketNotification("BIRDFY_STATUS", { configError: null, configWarning, source: sources.length ? "cloud" : "webhook" });

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
			if (now - alert.timestamp > this._maxAlertAge("cloud")) continue;
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

	// ── Home Assistant mode ─────────────────────────────────────────────────
	//
	// One persistent WebSocket to HA (auth, get_states, subscribe_events
	// state_changed, ping/pong, reconnect, terminal auth_invalid), following the
	// MMM-HomeAssistantStatusDashboard lifecycle. The long-lived token stays in
	// this process: it is only ever sent to HA, never to the front end.

	_now () {
		return Date.now();
	},

	_haInit () {
		this.statePath = nodePath.join(__dirname, STATE_FILE);
		this.imageRouteRegistered = false;
		this.ha = {
			ws: null,
			cfg: null,
			sig: null,
			base: null,
			token: "",
			msgId: 1,
			snapshotId: null,
			reconnectTimer: null,
			heartbeatTimer: null,
			midnightTimer: null,
			debounce: new Map(),
			awaitingPong: false,
			stopping: false,
			authFailed: false,
			started: false,
			connected: false,
			snapshotDone: false,
			connectedAt: 0,
			failures: 0,
			errors: {},
			feeders: [],
			entityMap: new Map(), // entity_id -> { feeder, role }
			watched: [],
			states: new Map(), // entity_id -> { state, attributes } for watched entities only
			day: { date: null, seen: new Set(), cross: new Map() },
			persistedFeeders: {},
			hasPersisted: false
		};
	},

	// Token precedence: haToken, then the file named by haTokenFile, then the
	// BIRDFY_HA_TOKEN environment variable. The file and env routes keep the
	// token out of config.js, which MagicMirror serves to browsers.
	_resolveHaToken (cfg) {
		this._haTokenSource = "haToken";
		if (typeof cfg.haToken === "string" && cfg.haToken.trim()) return cfg.haToken.trim();
		if (typeof cfg.haTokenFile === "string" && cfg.haTokenFile.trim()) {
			try {
				const fromFile = fs.readFileSync(cfg.haTokenFile.trim(), "utf8").trim();
				if (fromFile) {
					this._haTokenSource = `haTokenFile (${nodePath.basename(cfg.haTokenFile.trim())})`;
					return fromFile;
				}
			} catch (err) {
				Log.warn(`[MMM-Birdfy] Could not read haTokenFile (${err.code || "error"})`);
			}
		}
		this._haTokenSource = `the ${HA_TOKEN_ENV} environment variable`;
		return (process.env[HA_TOKEN_ENV] || "").trim();
	},

	// Validate config, then (re)start the HA connection unless nothing changed.
	_configureHomeAssistant (sources, webhookEnabled) {
		const cfg = this.config;
		const base = normaliseHaUrl(cfg.haUrl);
		const token = this._resolveHaToken(cfg);

		if (!base || !token) {
			this._haShutdown();
			const problems = [];
			if (!base) problems.push("haUrl (an http:// or https:// address)");
			if (!token) problems.push(`a token (haToken, haTokenFile or the ${HA_TOKEN_ENV} environment variable)`);
			this.sendSocketNotification("BIRDFY_STATUS", {
				configError: `Home Assistant mode needs ${problems.join(" and ")}.`,
				configWarning: null,
				source: "homeassistant",
				connected: false
			});
			this.sendSocketNotification("BIRDFY_READY", {});
			return;
		}

		if (sources.length) {
			Log.warn("[MMM-Birdfy] config.sources is ignored in homeassistant mode (Home Assistant is the data source).");
		}
		if (webhookEnabled && !this.webhookServer) this._startWebhookServer();
		this._haRegisterImageRoute();

		const sig = crypto.createHash("sha256").update(JSON.stringify([base, token, cfg.feeders || [], !!cfg.haAllowSelfSigned])).digest("hex");
		// Full current status for the (re)connecting client: after a browser reload
		// it must see a terminal auth/discovery error, not "reconnecting".
		const same = this.ha.started && this.ha.sig === sig;
		const current = same ? this._haCurrentError() : null;
		const terminal = same && (this.ha.authFailed || !!(current && current.terminal));
		this.sendSocketNotification("BIRDFY_STATUS", {
			configError: null,
			configWarning: null,
			source: "homeassistant",
			connected: same ? this.ha.connected : false,
			retrying: !terminal,
			haError: current ? { kind: current.kind, message: current.message, since: current.since, terminal: current.terminal } : null
		});
		this.sendSocketNotification("BIRDFY_READY", {});

		if (same) {
			// Same config resent (a browser reload): keep the connection and state,
			// just refresh the new page's idle view.
			this.ha.cfg = this.config;
			this._haSendToday();
			return;
		}
		this._haShutdown();
		this.ha.sig = sig;
		this.ha.base = base;
		this.ha.token = token;
		this._haStart();
	},

	_haStart () {
		const ha = this.ha;
		ha.cfg = this.config;
		ha.stopping = false;
		ha.authFailed = false;
		ha.started = true;
		ha.failures = 0;
		this._haLoadState();
		ha.feeders = (Array.isArray(this.config.feeders) ? this.config.feeders : [])
			.filter((f) => f && typeof f.speciesEntity === "string" && f.speciesEntity)
			.map((f, i) => this._haNewFeeder(f, i));
		this._haIndexFeeders();
		this._haScheduleMidnight();
		this._haConnect();
	},

	// Build the runtime record for one feeder; entity ids derive from the species sensor.
	_haNewFeeder (def, index) {
		const stem = speciesStem(def.speciesEntity);
		const feeder = {
			index,
			name: def.name || (stem ? stem.replace(/_/g, " ") : def.speciesEntity),
			speciesEntity: def.speciesEntity,
			imageEntity: def.imageEntity || (stem ? `image.${stem}_last_bird` : null),
			lastSpeciesEntity: stem ? `sensor.${stem}_last_bird_species` : null,
			thumbs: {},
			lastEventAt: 0,
			lastImageState: null
		};
		this._haResetFeederDay(feeder);
		this._haHydrate(feeder);
		return feeder;
	},

	_haResetFeederDay (f) {
		f.speciesKnown = new Set(); // species in today's list (event fired or primed)
		f.hlSpecies = new Set(); // species this feeder has reported highlights for today
		f.detections = {}; // species -> detections observed without highlights
		f.seenAt = {}; // species -> last time (ms) for the detections fallback
		f.lastDetection = null;
	},

	_haIndexFeeders () {
		const ha = this.ha;
		ha.entityMap = new Map();
		for (const f of ha.feeders) {
			ha.entityMap.set(f.speciesEntity, { feeder: f, role: "species" });
			if (f.lastSpeciesEntity) ha.entityMap.set(f.lastSpeciesEntity, { feeder: f, role: "last" });
			if (f.imageEntity) ha.entityMap.set(f.imageEntity, { feeder: f, role: "image" });
		}
		ha.watched = [...ha.entityMap.keys()];
	},

	// ── Persistence (so a restart does not re-announce today's birds) ──────

	_haLoadState () {
		const ha = this.ha;
		const today = localDateString(this._now());
		ha.day = { date: today, seen: new Set(), cross: new Map() };
		ha.persistedFeeders = {};
		try {
			const saved = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
			ha.hasPersisted = true;
			if (saved && saved.date === today) {
				ha.day.seen = new Set(Array.isArray(saved.seen) ? saved.seen : []);
				for (const row of Array.isArray(saved.cross) ? saved.cross : []) {
					if (Array.isArray(row) && row.length >= 4) ha.day.cross.set(row[0], { species: row[1], time: Number(row[2]), feeder: row[3] });
				}
				ha.persistedFeeders = saved.feeders && typeof saved.feeders === "object" ? saved.feeders : {};
			}
		} catch {
			// No usable file: first run (or unreadable). The first snapshot only primes.
			ha.hasPersisted = false;
		}
	},

	_haHydrate (f) {
		const saved = this.ha.persistedFeeders[f.speciesEntity];
		if (!saved || typeof saved !== "object") return;
		f.speciesKnown = new Set(Array.isArray(saved.speciesKnown) ? saved.speciesKnown : []);
		f.hlSpecies = new Set(Array.isArray(saved.hlSpecies) ? saved.hlSpecies : []);
		f.detections = saved.detections && typeof saved.detections === "object" ? { ...saved.detections } : {};
		f.seenAt = saved.seenAt && typeof saved.seenAt === "object" ? { ...saved.seenAt } : {};
		f.lastDetection = typeof saved.lastDetection === "string" ? saved.lastDetection : null;
	},

	_haSaveState () {
		const ha = this.ha;
		const feeders = {};
		for (const f of ha.feeders) {
			feeders[f.speciesEntity] = {
				speciesKnown: [...f.speciesKnown],
				hlSpecies: [...f.hlSpecies],
				detections: f.detections,
				seenAt: f.seenAt,
				lastDetection: f.lastDetection
			};
		}
		const data = {
			version: 1,
			date: ha.day.date,
			seen: [...ha.day.seen],
			cross: [...ha.day.cross].map(([key, c]) => [key, c.species, c.time, c.feeder]),
			feeders
		};
		const tmp = `${this.statePath}.tmp`;
		try {
			fs.writeFileSync(tmp, JSON.stringify(data));
			fs.renameSync(tmp, this.statePath);
			ha.hasPersisted = true;
		} catch (err) {
			Log.warn(`[MMM-Birdfy] Could not save state file: ${err.code || err.message}`);
		}
	},

	// ── Day rollover ───────────────────────────────────────────────────────

	// Reset per-day state when the local date changes. Returns true if it did.
	_haRollIfNeeded (now) {
		const ha = this.ha;
		const today = localDateString(now);
		if (ha.day.date === today) return false;
		ha.day = { date: today, seen: new Set(), cross: new Map() };
		ha.persistedFeeders = {};
		for (const f of ha.feeders) this._haResetFeederDay(f);
		return true;
	},

	_haScheduleMidnight () {
		const ha = this.ha;
		if (ha.midnightTimer) clearTimeout(ha.midnightTimer);
		const next = new Date(this._now());
		next.setHours(24, 0, 0, 0);
		const delay = Math.max(1000, next.getTime() - this._now() + 1000);
		ha.midnightTimer = setTimeout(() => {
			ha.midnightTimer = null;
			this._haOnMidnight();
			if (ha.started) this._haScheduleMidnight();
		}, delay);
		if (ha.midnightTimer.unref) ha.midnightTimer.unref();
	},

	_haOnMidnight () {
		if (this._haRollIfNeeded(this._now())) {
			this._haSaveState();
			this._haSendToday();
		}
	},

	// ── WebSocket lifecycle ────────────────────────────────────────────────

	_haConnect () {
		const ha = this.ha;
		if (ha.ws) {
			try { ha.ws.terminate(); } catch { /* socket may already be closed */ }
			ha.ws = null;
		}
		const url = `${ha.base.replace(/^http/, "ws")}/api/websocket`;
		Log.log("[MMM-Birdfy] Connecting to Home Assistant");

		let ws;
		try {
			ws = new WebSocket(url, {
				rejectUnauthorized: !ha.cfg.haAllowSelfSigned,
				handshakeTimeout: 15000
			});
		} catch (err) {
			Log.error(`[MMM-Birdfy] Could not create WebSocket: ${err.message}`);
			this._haConnectionLost();
			return;
		}
		ha.ws = ws;
		ha.msgId = 1;

		ws.on("message", (data) => {
			if (ha.ws !== ws) return; // stale socket
			this._haHandleMessage(data.toString());
		});
		ws.on("close", (code) => {
			if (ha.ws !== ws) return; // stale socket
			Log.log(`[MMM-Birdfy] Home Assistant WebSocket closed (${code})`);
			ha.ws = null;
			this._haConnectionLost();
		});
		ws.on("error", (err) => {
			// 'close' follows 'error', so reconnect is handled there.
			Log.error(`[MMM-Birdfy] Home Assistant WebSocket error: ${err.message}`);
		});
	},

	_haConnectionLost () {
		const ha = this.ha;
		this._haStopHeartbeat();
		const wasConnected = ha.connected;
		ha.connected = false;
		ha.snapshotDone = false;
		ha.failures += 1;
		const retrying = !(ha.stopping || ha.authFailed);
		if (wasConnected || ha.failures === 1) {
			this.sendSocketNotification("BIRDFY_STATUS", { connected: false, retrying, source: "homeassistant" });
		}
		// A rejected token is terminal: retrying only invites an HA IP ban.
		if (!retrying) return;
		if (ha.failures >= HA_ERROR_AFTER_FAILURES) {
			this._haSetError("connection", "Home Assistant is unreachable; retrying.", false);
		}
		this._haScheduleReconnect();
	},

	_haScheduleReconnect () {
		const ha = this.ha;
		if (ha.reconnectTimer) return;
		const base = (ha.cfg && Number(ha.cfg.reconnectInterval)) || HA_RECONNECT_MIN_MS;
		const delay = Math.min(HA_RECONNECT_MAX_MS, base * (2 ** Math.max(0, ha.failures - 1)));
		Log.log(`[MMM-Birdfy] Reconnecting to Home Assistant in ${Math.round(delay / 1000)}s`);
		ha.reconnectTimer = setTimeout(() => {
			ha.reconnectTimer = null;
			if (ha.started && !ha.stopping) this._haConnect();
		}, delay);
	},

	_haSend (obj) {
		const ws = this.ha.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(obj));
		} catch (err) {
			Log.error(`[MMM-Birdfy] Home Assistant send error: ${err.message}`);
		}
	},

	// A Wi-Fi drop can leave a half-open TCP socket that never fires 'close'.
	// Ping HA periodically and force a reconnect if a pong does not come back.
	_haStartHeartbeat () {
		const ha = this.ha;
		this._haStopHeartbeat();
		const interval = (ha.cfg && Number(ha.cfg.heartbeatInterval)) || HA_DEFAULT_HEARTBEAT_MS;
		ha.heartbeatTimer = setInterval(() => {
			if (ha.awaitingPong) {
				Log.warn("[MMM-Birdfy] No pong from Home Assistant; reconnecting");
				this._haStopHeartbeat();
				if (ha.ws) {
					try { ha.ws.terminate(); } catch { /* socket may already be closed */ }
				}
				return;
			}
			ha.awaitingPong = true;
			this._haSend({ id: ha.msgId++, type: "ping" });
		}, interval);
		if (ha.heartbeatTimer.unref) ha.heartbeatTimer.unref();
	},

	_haStopHeartbeat () {
		const ha = this.ha;
		if (ha.heartbeatTimer) {
			clearInterval(ha.heartbeatTimer);
			ha.heartbeatTimer = null;
		}
		ha.awaitingPong = false;
	},

	// Report a Home Assistant problem in BIRDFY_STATUS.haError, once per distinct
	// kind and message. kind: "auth" | "discovery" | "connection"; terminal means
	// the module will not retry on its own.
	_haSetError (kind, message, terminal) {
		const ha = this.ha;
		const cur = ha.errors[kind];
		if (cur && cur.message === message) return;
		const since = cur ? cur.since : this._now();
		ha.errors[kind] = { kind, message, since, terminal };
		Log.error(`[MMM-Birdfy] ${message}`);
		this._haPublishError();
	},

	_haClearError (kind) {
		const ha = this.ha;
		if (!ha.errors[kind]) return;
		delete ha.errors[kind];
		this._haPublishError();
	},

	// Send the most severe active error (auth, then discovery, then connection), or null.
	_haCurrentError () {
		const errors = this.ha.errors;
		return errors.auth || errors.discovery || errors.connection || null;
	},

	_haPublishError () {
		const e = this._haCurrentError();
		this.sendSocketNotification("BIRDFY_STATUS", {
			haError: e ? { kind: e.kind, message: e.message, since: e.since, terminal: e.terminal } : null,
			source: "homeassistant"
		});
	},

	_haHandleMessage (raw) {
		const ha = this.ha;
		// HA emits thousands of unrelated state changes an hour; skip parsing the
		// ones that cannot concern a Birdfy entity.
		if (ha.snapshotDone && raw.includes("\"type\":\"event\"") && !ha.watched.some((id) => raw.includes(id))) return;

		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		switch (msg.type) {
			case "auth_required":
				this._haSend({ type: "auth", access_token: ha.token });
				break;

			case "auth_ok":
				Log.log(`[MMM-Birdfy] Home Assistant authenticated (HA ${msg.ha_version})`);
				ha.failures = 0;
				ha.connected = true;
				ha.connectedAt = this._now();
				ha.snapshotDone = false;
				ha.snapshotId = ha.msgId++;
				this._haSend({ id: ha.snapshotId, type: "get_states" });
				this._haSend({ id: ha.msgId++, type: "subscribe_events", event_type: "state_changed" });
				this._haStartHeartbeat();
				this._haClearError("connection");
				this.sendSocketNotification("BIRDFY_STATUS", { connected: true, source: "homeassistant" });
				break;

			case "auth_invalid":
				Log.error("[MMM-Birdfy] Home Assistant rejected the access token; not retrying");
				ha.authFailed = true;
				this._haSetError("auth", `Home Assistant rejected the access token (check ${this._haTokenSource || "haToken"}).`, true);
				break;

			case "pong":
				ha.awaitingPong = false;
				break;

			case "result":
				if (msg.id === ha.snapshotId) {
					if (msg.success && Array.isArray(msg.result)) {
						this._haIngestSnapshot(msg.result);
					} else {
						Log.warn("[MMM-Birdfy] Home Assistant get_states failed");
						this._haSetError("connection", "Could not read states from Home Assistant.", false);
					}
				} else if (!msg.success) {
					Log.warn(`[MMM-Birdfy] Home Assistant command failed (${msg.error && msg.error.code})`);
				}
				break;

			case "event":
				this._haHandleEvent(msg.event);
				break;

			default:
				break;
		}
	},

	// ── State handling ─────────────────────────────────────────────────────

	// The get_states snapshot after every (re)connect.
	_haIngestSnapshot (list) {
		const ha = this.ha;
		const byId = new Map();
		for (const s of list) if (s && typeof s.entity_id === "string") byId.set(s.entity_id, s);

		if (!ha.feeders.length) {
			ha.feeders = this._haDiscover(byId);
			this._haIndexFeeders();
			if (!ha.feeders.length) {
				this._haSetError("discovery", "No Birdfy sensors found in Home Assistant (expected sensor.*_bird_species).", true);
				return;
			}
			this._haClearError("discovery");
			Log.log(`[MMM-Birdfy] Auto-discovered ${ha.feeders.length} Birdfy feeder(s)`);
		}

		ha.states = new Map();
		for (const id of ha.watched) {
			const s = byId.get(id);
			if (s) ha.states.set(id, { state: s.state, attributes: s.attributes || {} });
		}
		for (const f of ha.feeders) {
			if (!byId.has(f.speciesEntity)) Log.warn(`[MMM-Birdfy] ${f.speciesEntity} not found in Home Assistant`);
		}

		ha.snapshotDone = true;
		const events = [];
		for (const f of ha.feeders) events.push(...this._haProcessFeeder(f, true));
		this._haFinish(events);
	},

	// Find sensor.*_bird_species (and the matching image.*_last_bird) when feeders are not configured.
	_haDiscover (byId) {
		const feeders = [];
		for (const [id, st] of byId) {
			const stem = speciesStem(id);
			if (!stem) continue;
			feeders.push(this._haNewFeeder({
				name: discoveredName(st, stem),
				speciesEntity: id,
				imageEntity: byId.has(`image.${stem}_last_bird`) ? `image.${stem}_last_bird` : null
			}, feeders.length));
		}
		return feeders;
	},

	_haHandleEvent (event) {
		const ha = this.ha;
		if (!ha.snapshotDone || !event || event.event_type !== "state_changed" || !event.data) return;
		const { entity_id: id, new_state: next, old_state: prev } = event.data;
		const link = ha.entityMap.get(id);
		if (!link) return;

		if (next) {
			ha.states.set(id, { state: next.state, attributes: next.attributes || {} });
		} else {
			ha.states.delete(id);
		}
		if (link.role === "image") {
			// The image entity ticks on token rotation and HA restarts; it is only
			// a detection signal when explicitly enabled.
			if (ha.cfg.imageChangeDetection && next && prev && next.state !== prev.state) {
				this._haFinish(this._haProcessImageChange(link.feeder, next));
			}
			return;
		}
		this._haSchedule(link.feeder);
	},

	// Coalesce the burst of entity updates the integration writes per refresh.
	_haSchedule (f) {
		const ha = this.ha;
		const delay = ha.cfg.haDebounceMs === undefined ? HA_DEFAULT_DEBOUNCE_MS : Number(ha.cfg.haDebounceMs);
		if (!(delay > 0)) {
			this._haFinish(this._haProcessFeeder(f, false));
			return;
		}
		if (ha.debounce.has(f)) return;
		const timer = setTimeout(() => {
			ha.debounce.delete(f);
			if (ha.started && ha.snapshotDone) this._haFinish(this._haProcessFeeder(f, false));
		}, delay);
		if (timer.unref) timer.unref();
		ha.debounce.set(f, timer);
	},

	/**
	 * Diff one feeder's current attributes against what was already seen today.
	 * Detection signals, in order of preference: new highlight items; a species
	 * newly present in species_list; an advancing last_detection (only when no
	 * highlights are exposed). Counts are updated as a side effect.
	 * @param {object} f The feeder record.
	 * @param {boolean} initial True for the get_states snapshot (startup/reconnect).
	 * @returns {Array<object>} Detection events (each flagged `alert` or silent).
	 */
	_haProcessFeeder (f, initial) {
		const ha = this.ha;
		const now = this._now();
		this._haRollIfNeeded(now);
		const st = ha.states.get(f.speciesEntity);
		if (!isUsableState(st)) return [];
		const a = st.attributes || {};

		const dayStart = startOfLocalDay(now);
		const dayEnd = dayStart + (24 * 60 * 60 * 1000);
		// The integration refreshes every 15 min, so right after midnight its
		// attributes still describe yesterday. Do not read those as today's birds.
		const windowStart = parseLocalIso(a.start_time);
		const fresh = (a.date_range === undefined || a.date_range === "today") && (windowStart === null || windowStart >= dayStart);

		const events = [];

		if (fresh) {
			f.thumbs = {};
			for (const [name, url] of Object.entries(parseObject(a.thumbnails))) {
				const species = cleanSpecies(name);
				const safe = safeUrl(url);
				if (species && safe) f.thumbs[species] = safe;
			}
		}

		// 1. Highlight items (stable key: time|species|video_url).
		const items = [];
		for (const raw of parseList(a.highlights)) {
			if (!raw || typeof raw !== "object") continue;
			const species = cleanSpecies(raw.species);
			const time = Number(raw.time);
			if (!species || !Number.isFinite(time) || time < dayStart || time >= dayEnd) continue;
			items.push({ species, time, video: typeof raw.video_url === "string" ? raw.video_url : "" });
		}
		items.sort((x, y) => x.time - y.time);
		for (const it of items) {
			f.hlSpecies.add(it.species);
			const key = `${it.time}|${it.species}|${it.video}`;
			const cross = `${it.time}|${it.video}`;
			if (ha.day.seen.has(key)) continue;
			ha.day.seen.add(key);
			// The same clip reported by two feeders is one visit.
			if (ha.day.cross.has(cross)) continue;
			ha.day.cross.set(cross, { species: it.species, time: it.time, feeder: f.name });
			events.push({ kind: "highlight", feeder: f, species: it.species, time: it.time, timeKnown: true, id: `ha-h-${shortHash(key)}`, videoUrl: safeUrl(it.video) });
		}

		// 2. Species newly present in today's list (works when highlights are stripped).
		let list = [];
		if (fresh) {
			list = parseList(a.species_list).map(cleanSpecies).filter(Boolean);
			if (a.species_list === undefined && typeof st.state === "string" && st.state !== "No birds today") {
				list = st.state.split(",").map(cleanSpecies).filter(Boolean);
			}
		}
		let lastDetectionMs = fresh ? parseLocalIso(a.last_detection) : null;
		if (lastDetectionMs !== null && lastDetectionMs < dayStart) lastDetectionMs = null;
		for (const species of list) {
			if (f.speciesKnown.has(species)) continue;
			f.speciesKnown.add(species);
			if (f.hlSpecies.has(species)) continue; // the highlight path owns this species
			f.detections[species] = (f.detections[species] || 0) + 1;
			f.seenAt[species] = lastDetectionMs === null ? now : lastDetectionMs;
			events.push({ kind: "species", feeder: f, species, time: f.seenAt[species], timeKnown: lastDetectionMs !== null, id: `ha-s-${ha.day.date}-${shortHash(`${f.speciesEntity}|${species}`)}`, videoUrl: null });
		}

		// 3. last_detection advancing, for species already known and no highlights.
		if (fresh && typeof a.last_detection === "string" && a.last_detection !== f.lastDetection) {
			const prev = f.lastDetection;
			f.lastDetection = a.last_detection;
			if (prev && !events.length && !items.length) {
				const last = ha.states.get(f.lastSpeciesEntity);
				const species = cleanSpecies(isUsableState(last) ? last.state : null) || (list.length === 1 ? list[0] : null);
				if (species) {
					f.speciesKnown.add(species);
					f.detections[species] = (f.detections[species] || 0) + 1;
					f.seenAt[species] = lastDetectionMs === null ? now : lastDetectionMs;
					events.push({ kind: "detection", feeder: f, species, time: f.seenAt[species], timeKnown: lastDetectionMs !== null, id: `ha-d-${shortHash(`${f.speciesEntity}|${a.last_detection}`)}`, videoUrl: null });
				}
			}
		}

		for (const ev of events) {
			ev.alert = this._haAlertable(ev, initial, now);
			ev.replay = !!initial;
		}
		if (events.length) f.lastEventAt = now;
		return events;
	},

	/**
	 * Opt-in (imageChangeDetection): an image entity timestamp change that does
	 * not correspond to a known highlight counts as one detection.
	 * @param {object} f The feeder record.
	 * @param {object} next The image entity's new HA state.
	 * @returns {Array<object>} Zero or one detection events.
	 */
	_haProcessImageChange (f, next) {
		const ha = this.ha;
		const now = this._now();
		this._haRollIfNeeded(now);
		if (now - ha.connectedAt < HA_IMAGE_SETTLE_MS) return [];
		if (f.lastImageState === next.state) return [];
		f.lastImageState = next.state;
		const attrs = next.attributes || {};
		const species = cleanSpecies(attrs.species);
		if (!species) return [];
		const detectedAt = parseLocalIso(attrs.detection_time);
		const known = [...ha.day.cross.values()].some((c) => c.species === species && detectedAt !== null && Math.abs(c.time - detectedAt) < 2000);
		if (known || now - f.lastEventAt < 90000) return [];
		f.speciesKnown.add(species);
		f.detections[species] = (f.detections[species] || 0) + 1;
		f.seenAt[species] = now;
		f.lastEventAt = now;
		return [{ kind: "image", feeder: f, species, time: now, timeKnown: true, alert: true, id: `ha-i-${shortHash(`${f.speciesEntity}|${next.state}`)}`, videoUrl: null }];
	},

	// Age limit for surfacing an alert. Unset (null/undefined/invalid) resolves to
	// 60 min in Home Assistant mode (the integration polls every 15 min) and
	// 30 min in cloud mode.
	_maxAlertAge (mode) {
		const configured = Number(this.config && this.config.maxAlertAge);
		if (this.config && this.config.maxAlertAge !== null && configured > 0) return configured;
		return mode === "homeassistant" ? HA_DEFAULT_MAX_ALERT_AGE_MS : CLOUD_DEFAULT_MAX_ALERT_AGE_MS;
	},

	// Should this event raise an alert, or only be counted silently?
	_haAlertable (ev, initial, now) {
		const maxAge = this._maxAlertAge("homeassistant");
		if (!initial) return ev.kind === "highlight" ? now - ev.time <= maxAge : true;
		// A snapshot only alerts for things that arrived while we were away, which
		// needs a state file from a previous run to tell "new" from "already seen".
		if (!this.ha.hasPersisted || !ev.timeKnown) return false;
		return now - ev.time <= maxAge;
	},

	// Persist, refresh the idle view, and alert for the newest eligible event.
	_haFinish (events) {
		this._haSaveState();
		this._haSendToday();
		const newest = events.filter((e) => e.alert).sort((x, y) => x.time - y.time).pop();
		if (newest) this._haSendAlert(newest);
	},

	// ── Counts and payloads ────────────────────────────────────────────────

	/**
	 * Today's visits per species, all feeders summed. Highlight items are
	 * counted once each (de-duplicated across feeders); species a feeder lists
	 * without exposing highlights count as the detections observed (min 1).
	 * @returns {{by: Map<string, object>, total: number}} Per-species counts and the overall total.
	 */
	_haCounts () {
		const ha = this.ha;
		const by = new Map();
		const bump = (name, n, lastSeen, highlights) => {
			const cur = by.get(name) || { name, count: 0, lastSeen: 0, highlights: false };
			cur.count += n;
			cur.lastSeen = Math.max(cur.lastSeen, lastSeen || 0);
			cur.highlights = cur.highlights || highlights;
			by.set(name, cur);
		};
		for (const c of ha.day.cross.values()) {
			const species = cleanSpecies(c.species);
			if (species) bump(species, 1, c.time, true);
		}
		for (const f of ha.feeders) {
			for (const species of f.speciesKnown) {
				if (f.hlSpecies.has(species)) continue;
				bump(species, Math.max(1, f.detections[species] || 0), f.seenAt[species], false);
			}
		}
		let total = 0;
		for (const v of by.values()) total += v.count;
		return { by, total };
	},

	// A browser-loadable image for a species: public URL first, token-free proxy last.
	_haImageFor (species, preferred) {
		const ha = this.ha;
		const order = preferred ? [preferred, ...ha.feeders.filter((f) => f !== preferred)] : ha.feeders;
		for (const f of order) {
			if (f.thumbs[species]) return f.thumbs[species];
		}
		for (const f of order) {
			const img = f.imageEntity && ha.states.get(f.imageEntity);
			const attrs = img && img.attributes;
			if (!attrs || cleanSpecies(attrs.species) !== species) continue;
			const publicUrl = safeUrl(attrs.image_url);
			if (publicUrl) return publicUrl;
			if (attrs.entity_picture) return `/birdfy/image/${f.index}?t=${encodeURIComponent(img.state)}`;
		}
		return null;
	},

	_haSendToday () {
		const ha = this.ha;
		if (!ha.day.date) return;
		const { by, total } = this._haCounts();
		const visitors = [...by.values()]
			.sort((x, y) => (y.lastSeen - x.lastSeen) || x.name.localeCompare(y.name))
			.map((v) => ({ name: v.name, count: v.count, imageUrl: this._haImageFor(v.name), lastSeen: v.lastSeen || null, countSource: v.highlights ? "highlights" : "detections" }));
		const sources = new Set([...by.values()].map((v) => (v.highlights ? "highlights" : "detections")));
		this._haEmit("BIRDFY_TODAY", {
			visitors,
			totalVisitsToday: total,
			countSource: sources.size === 0 ? null : (sources.size === 2 ? "mixed" : [...sources][0]),
			speciesCount: visitors.length,
			date: ha.day.date
		});
	},

	_haSendAlert (ev) {
		const { by, total } = this._haCounts();
		const entry = by.get(ev.species);
		this._haEmit("BIRDFY_ALERT", {
			id: ev.id,
			species: ev.species,
			feeder: ev.feeder.name,
			deviceName: ev.feeder.name,
			timestamp: ev.time,
			imageUrl: this._haImageFor(ev.species, ev.feeder),
			videoUrl: ev.videoUrl || null,
			streamUrl: null,
			speciesVisitsToday: entry ? entry.count : 1,
			totalVisitsToday: total,
			countSource: entry && entry.highlights ? "highlights" : "detections",
			...(ev.replay ? { replay: true } : {})
		});
	},

	// Every HA-derived notification passes through here so the token can never
	// reach the front end, even through a bug or an odd attribute value.
	_haEmit (notification, payload) {
		const token = this.ha.token;
		if (token && JSON.stringify(payload).includes(token)) {
			Log.error(`[MMM-Birdfy] Dropped ${notification}: payload contained the Home Assistant token`);
			return;
		}
		this.sendSocketNotification(notification, payload);
	},

	// ── Image proxy (keeps the HA token server-side) ───────────────────────

	_haRegisterImageRoute () {
		if (this.imageRouteRegistered || !this.expressApp) return;
		this.imageRouteRegistered = true;
		this.expressApp.get(IMAGE_PROXY_PATH, (req, res) => this._haImageProxy(req, res));
	},

	_haImageProxy (req, res) {
		const ha = this.ha;
		const feeder = ha.started ? ha.feeders[Number.parseInt(req.params.feederIndex, 10)] : null;
		if (!feeder || !feeder.imageEntity || !(/^image\.\w+$/).test(feeder.imageEntity)) {
			res.status(404).type("text/plain").send("not found");
			return;
		}
		const fail = () => {
			if (!res.headersSent) {
				res.status(502).type("text/plain").send("image unavailable");
			} else {
				res.destroy();
			}
		};
		let url;
		try {
			url = new URL(`${ha.base}/api/image_proxy/${feeder.imageEntity}`);
		} catch {
			fail();
			return;
		}
		const lib = url.protocol === "https:" ? https : http;
		const upstream = lib.request(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${ha.token}` },
			timeout: IMAGE_PROXY_TIMEOUT_MS,
			rejectUnauthorized: !ha.cfg.haAllowSelfSigned
		}, (r) => {
			const type = r.headers["content-type"] || "";
			if (r.statusCode !== 200 || !PROXY_IMAGE_TYPES.test(type)) {
				r.resume();
				fail();
				return;
			}
			res.status(200);
			res.set("Content-Type", type);
			res.set("X-Content-Type-Options", "nosniff");
			res.set("Cache-Control", "private, max-age=300");
			let bytes = 0;
			r.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > IMAGE_PROXY_MAX_BYTES) {
					upstream.destroy();
					res.destroy();
				}
			});
			r.pipe(res);
		});
		upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
		upstream.on("error", fail);
		upstream.end();
	},

	_haShutdown () {
		const ha = this.ha;
		ha.stopping = true;
		ha.started = false;
		ha.sig = null;
		ha.connected = false;
		ha.snapshotDone = false;
		ha.authFailed = false;
		ha.errors = {};
		this._haStopHeartbeat();
		for (const timer of ["reconnectTimer", "midnightTimer"]) {
			if (ha[timer]) {
				clearTimeout(ha[timer]);
				ha[timer] = null;
			}
		}
		for (const timer of ha.debounce.values()) clearTimeout(timer);
		ha.debounce.clear();
		if (ha.ws) {
			const ws = ha.ws;
			ha.ws = null;
			try { ws.terminate(); } catch { /* socket may already be closed */ }
		}
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
		this._haShutdown();
		if (this.webhookServer) this.webhookServer.close();
	},

	// Exposed only so the test suite can exercise pure helpers directly.
	_testables: {
		toAlert,
		normaliseAlert,
		safeUrl,
		resolveTimestamp,
		isWebhookAuthorized,
		cleanSpecies,
		parseList,
		parseObject,
		parseLocalIso,
		normaliseHaUrl,
		speciesStem
	}
});
