"use strict";

// Home Assistant mode of node_helper: message handling, de-dupe, counts,
// day rollover, the image proxy, the WebSocket lifecycle, and the guarantee
// that the HA token never reaches the front end.

require("./support/mm-stubs");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { WebSocketServer } = require("ws");
const NodeHelperClass = require("../node_helper");

const TOKEN = "SECRET-LONG-LIVED-TOKEN-123";
const MIN = 60 * 1000;

const FEEDERS = [
	{ name: "Feeder", speciesEntity: "sensor.birdfy_bird_feeder_bird_species", imageEntity: "image.birdfy_bird_feeder_last_bird" },
	{ name: "Bird House", speciesEntity: "sensor.birdfy_bird_house_bird_species", imageEntity: "image.birdfy_bird_house_last_bird" },
	{ name: "Backyard", speciesEntity: "sensor.backyard_birdfy_metal_4k_bird_species", imageEntity: "image.backyard_birdfy_metal_4k_last_bird" }
];

let tmpCounter = 0;

/**
 * @param {Date} d A date.
 * @returns {string} Naive local ISO, as the integration writes start_time.
 */
function localIso (d) {
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Build a helper in Home Assistant mode with a fake clock, a private state
 * file, and the real connection stubbed out.
 * @param {object} opts Options: config overrides, statePath to reuse, clock start.
 * @returns {object} The helper, its sent log, the clock, and test utilities.
 */
function makeHa (opts = {}) {
	const helper = new NodeHelperClass();
	helper.name = "MMM-Birdfy";
	const sent = [];
	helper.sendSocketNotification = (notification, payload) => {
		sent.push({ notification, payload });
	};
	helper.start();
	helper.statePath = opts.statePath || path.join(os.tmpdir(), `birdfy-test-${process.pid}-${tmpCounter++}.json`);
	const clock = { now: opts.now || new Date(2026, 9, 1, 12, 0, 0).getTime() };
	helper._now = () => clock.now;
	let connects = 0;
	helper._haConnect = () => { connects += 1; };

	const config = {
		source: "homeassistant",
		haUrl: "https://ha.example.test:8123/",
		haToken: TOKEN,
		feeders: FEEDERS,
		maxAlertAge: 3600000,
		haDebounceMs: 0,
		...opts.config
	};
	helper.socketNotificationReceived("BIRDFY_CONFIG", config);

	const ctx = {
		helper,
		sent,
		clock,
		statePath: helper.statePath,
		connects: () => connects,
		of: (name) => sent.filter((n) => n.notification === name).map((n) => n.payload),
		clear: () => { sent.length = 0; },
		dayStart: () => new Date(new Date(clock.now).setHours(0, 0, 0, 0)),
		/** Species sensor state object. */
		sensor (feeder, attrs = {}, state) {
			const list = attrs.species_list;
			const stateText = state !== undefined ? state : (Array.isArray(list) && list.length ? list.join(", ") : "No birds today");
			return {
				entity_id: feeder.speciesEntity,
				state: stateText,
				attributes: {
					species_count: Array.isArray(list) ? list.length : 0,
					species_list: [],
					thumbnails: {},
					highlights: [],
					date_range: "today",
					start_time: localIso(ctx.dayStart()),
					end_time: localIso(new Date(ctx.dayStart().getTime() + (24 * 3600000) - 1)),
					...attrs
				}
			};
		},
		snapshot (states) {
			helper.ha.snapshotDone = false;
			helper._haIngestSnapshot(states);
		},
		event (state, oldState = null) {
			helper._haHandleMessage(JSON.stringify({
				type: "event",
				event: { event_type: "state_changed", data: { entity_id: state.entity_id, new_state: state, old_state: oldState } }
			}));
		},
		stop () {
			helper._haShutdown();
			fs.rmSync(helper.statePath, { force: true });
		}
	};
	return ctx;
}

/**
 * @param {object} ctx The test context.
 * @param {string} species Species name.
 * @param {number} minutesAgo Age of the highlight.
 * @param {string} clip Clip name (becomes the video URL).
 * @returns {object} A highlight attribute item.
 */
function highlight (ctx, species, minutesAgo, clip) {
	return {
		species,
		title: "t",
		category: "birdMoment",
		time: ctx.clock.now - (minutesAgo * MIN),
		video_url: `https://blob.example.test/${clip}.mp4`
	};
}

const THUMBS = {
	"House Finch": "https://blob.example.test/finch.jpg",
	"Carolina Chickadee": "https://blob.example.test/chickadee.jpg"
};

// ── Highlight detection ─────────────────────────────────────────────────────

test("a new highlight raises one BIRDFY_ALERT with counts, and the same item is not announced twice", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS })]);
		assert.equal(t.of("BIRDFY_ALERT").length, 0, "first-ever snapshot only primes");

		const item = highlight(t, "House Finch", 2, "a");
		const state = t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [item], last_detection: localIso(new Date(item.time)) });
		t.event(state);

		const alerts = t.of("BIRDFY_ALERT");
		assert.equal(alerts.length, 1);
		const a = alerts[0];
		assert.equal(a.species, "House Finch");
		assert.equal(a.feeder, "Feeder");
		assert.equal(a.timestamp, item.time);
		assert.equal(a.imageUrl, THUMBS["House Finch"]);
		assert.equal(a.videoUrl, item.video_url);
		assert.equal(a.speciesVisitsToday, 1);
		assert.equal(a.totalVisitsToday, 1);
		assert.equal(a.countSource, "highlights");

		t.event(state);
		t.event(state);
		assert.equal(t.of("BIRDFY_ALERT").length, 1, "re-delivery of the same highlight must not re-alert");
	} finally {
		t.stop();
	}
});

test("several new highlights in one update alert once (newest) but all are counted", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder)]);
		const items = [highlight(t, "House Finch", 10, "a"), highlight(t, "Carolina Chickadee", 6, "b"), highlight(t, "House Finch", 1, "c")];
		t.event(t.sensor(feeder, { species_list: ["House Finch", "Carolina Chickadee"], thumbnails: THUMBS, highlights: items }));

		const alerts = t.of("BIRDFY_ALERT");
		assert.equal(alerts.length, 1);
		assert.equal(alerts[0].species, "House Finch");
		assert.equal(alerts[0].speciesVisitsToday, 2);
		assert.equal(alerts[0].totalVisitsToday, 3);
	} finally {
		t.stop();
	}
});

test("highlights older than maxAlertAge are counted but not announced", () => {
	const t = makeHa({ config: { maxAlertAge: 20 * MIN } });
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder)]);
		t.event(t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [highlight(t, "House Finch", 90, "old")] }));
		assert.equal(t.of("BIRDFY_ALERT").length, 0);
		assert.equal(t.of("BIRDFY_TODAY").pop().totalVisitsToday, 1);
	} finally {
		t.stop();
	}
});

test("list/dict attributes delivered as JSON strings are parsed the same as native values", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder)]);
		const item = highlight(t, "House Finch", 1, "a");
		const state = t.sensor(feeder, {
			species_list: JSON.stringify(["House Finch"]),
			thumbnails: JSON.stringify(THUMBS),
			highlights: JSON.stringify([item])
		}, "House Finch");
		t.event(state);
		const alerts = t.of("BIRDFY_ALERT");
		assert.equal(alerts.length, 1);
		assert.equal(alerts[0].imageUrl, THUMBS["House Finch"]);
	} finally {
		t.stop();
	}
});

test("highlights from before local midnight are ignored", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder)]);
		const yesterday = { ...highlight(t, "House Finch", 0, "y"), time: t.dayStart().getTime() - MIN };
		t.event(t.sensor(feeder, { highlights: [yesterday] }));
		assert.equal(t.of("BIRDFY_ALERT").length, 0);
		assert.equal(t.of("BIRDFY_TODAY").pop().totalVisitsToday, 0);
	} finally {
		t.stop();
	}
});

// ── Generic "bird" ──────────────────────────────────────────────────────────

test("the generic \"bird\" label is never announced or counted", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder)]);
		t.event(t.sensor(feeder, {
			species_list: ["bird", "Bird"],
			highlights: [highlight(t, "bird", 1, "g1"), highlight(t, "Bird", 2, "g2"), { ...highlight(t, "", 3, "g3"), species: null }]
		}, "bird, Bird"));
		assert.equal(t.of("BIRDFY_ALERT").length, 0);
		const today = t.of("BIRDFY_TODAY").pop();
		assert.equal(today.totalVisitsToday, 0);
		assert.deepEqual(today.visitors, []);
	} finally {
		t.stop();
	}
});

// ── Fallback detection (highlights stripped) ───────────────────────────────

test("a species newly in species_list alerts even when highlights is empty, counted as detections", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder)]);
		t.event(t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, last_detection: localIso(new Date(t.clock.now - MIN)) }));

		const alerts = t.of("BIRDFY_ALERT");
		assert.equal(alerts.length, 1);
		assert.equal(alerts[0].species, "House Finch");
		assert.equal(alerts[0].countSource, "detections");
		assert.equal(alerts[0].speciesVisitsToday, 1);
		assert.equal(alerts[0].totalVisitsToday, 1);
		assert.equal(alerts[0].imageUrl, THUMBS["House Finch"]);
		assert.equal(alerts[0].videoUrl, null);

		// Same species, no change: nothing.
		t.event(t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, last_detection: localIso(new Date(t.clock.now - MIN)) }));
		assert.equal(t.of("BIRDFY_ALERT").length, 1);

		// last_detection advances for the same species: a second detection.
		t.clock.now += 20 * MIN;
		t.event(t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, last_detection: localIso(new Date(t.clock.now - MIN)) }));
		const again = t.of("BIRDFY_ALERT");
		assert.equal(again.length, 2);
		assert.equal(again[1].species, "House Finch");
		assert.equal(again[1].speciesVisitsToday, 2);
		assert.equal(again[1].totalVisitsToday, 2);
	} finally {
		t.stop();
	}
});

test("the species list is read from the sensor state when the attribute is absent", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder)]);
		const state = t.sensor(feeder, { thumbnails: THUMBS }, "House Finch, Carolina Chickadee");
		delete state.attributes.species_list;
		t.event(state);
		assert.equal(t.of("BIRDFY_TODAY").pop().speciesCount, 2);
	} finally {
		t.stop();
	}
});

test("a last-bird image fallback supplies the picture when thumbnails lack the species", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([
			t.sensor(feeder),
			{ entity_id: feeder.imageEntity, state: "2026-10-01T11:00:00", attributes: { species: "Eastern Bluebird", image_url: "https://blob.example.test/bluebird.jpg", entity_picture: "/api/image_proxy/x?token=abc" } }
		]);
		t.event(t.sensor(feeder, { species_list: ["Eastern Bluebird"], thumbnails: {} }));
		const alert = t.of("BIRDFY_ALERT")[0];
		assert.equal(alert.imageUrl, "https://blob.example.test/bluebird.jpg");
	} finally {
		t.stop();
	}
});

test("the image proxy URL is used only when no public URL exists, and carries no token", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[1];
		t.snapshot([
			t.sensor(FEEDERS[0]),
			t.sensor(feeder),
			{ entity_id: feeder.imageEntity, state: "2026-10-01T11:00:00", attributes: { species: "Eastern Bluebird", entity_picture: "/api/image_proxy/image.x?token=ROTATING" } }
		]);
		t.event(t.sensor(feeder, { species_list: ["Eastern Bluebird"], thumbnails: {} }));
		const alert = t.of("BIRDFY_ALERT")[0];
		assert.equal(alert.imageUrl, `/birdfy/image/1?t=${encodeURIComponent("2026-10-01T11:00:00")}`);
		assert.doesNotMatch(JSON.stringify(t.sent), /ROTATING/);
	} finally {
		t.stop();
	}
});

// ── Restart de-dupe ─────────────────────────────────────────────────────────

test("restart does not re-announce today's already-seen highlights, and counts are rebuilt", () => {
	const first = makeHa();
	const feeder = FEEDERS[0];
	const item = highlight(first, "House Finch", 3, "a");
	const stateFor = (ctx) => ctx.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [item], last_detection: localIso(new Date(item.time)) });
	first.snapshot([first.sensor(feeder)]);
	first.event(stateFor(first));
	assert.equal(first.of("BIRDFY_ALERT").length, 1);
	first.helper._haShutdown();

	const second = makeHa({ statePath: first.statePath, now: first.clock.now });
	try {
		second.snapshot([stateFor(second)]);
		assert.equal(second.of("BIRDFY_ALERT").length, 0, "seen item must not be re-announced after a restart");
		const today = second.of("BIRDFY_TODAY").pop();
		assert.equal(today.totalVisitsToday, 1);
		assert.equal(today.visitors[0].name, "House Finch");
		assert.equal(today.visitors[0].count, 1);
	} finally {
		second.stop();
	}
});

test("a first-ever snapshot (no state file) primes silently even for a recent highlight", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [highlight(t, "House Finch", 2, "a")] })]);
		assert.equal(t.of("BIRDFY_ALERT").length, 0);
		assert.equal(t.of("BIRDFY_TODAY").pop().totalVisitsToday, 1);
	} finally {
		t.stop();
	}
});

test("a highlight that arrived while the mirror was down is announced on the next start if recent enough", () => {
	const first = makeHa();
	const feeder = FEEDERS[0];
	first.snapshot([first.sensor(feeder)]);
	first.helper._haShutdown();

	const second = makeHa({ statePath: first.statePath, now: first.clock.now });
	try {
		second.snapshot([second.sensor(feeder, {
			species_list: ["House Finch", "Carolina Chickadee"],
			thumbnails: THUMBS,
			highlights: [highlight(second, "House Finch", 10, "new"), highlight(second, "Carolina Chickadee", 600, "too-old")]
		})]);
		const alerts = second.of("BIRDFY_ALERT");
		assert.equal(alerts.length, 1);
		assert.equal(alerts[0].species, "House Finch");
		assert.equal(alerts[0].totalVisitsToday, 2);
	} finally {
		second.stop();
	}
});

test("re-sending BIRDFY_CONFIG with the same settings keeps the connection and refreshes the idle view", () => {
	const t = makeHa();
	try {
		assert.equal(t.connects(), 1);
		t.snapshot([t.sensor(FEEDERS[0])]);
		t.clear();
		t.helper.socketNotificationReceived("BIRDFY_CONFIG", t.helper.config);
		assert.equal(t.connects(), 1, "must not reconnect");
		assert.equal(t.of("BIRDFY_TODAY").length, 1);
		assert.equal(t.of("BIRDFY_READY").length, 1);
		assert.equal(t.of("BIRDFY_ALERT").length, 0);
	} finally {
		t.stop();
	}
});

// ── Counts across feeders ──────────────────────────────────────────────────

test("counts sum across feeders, and the same clip reported by two feeders counts once", () => {
	const t = makeHa();
	try {
		const [a, b, c] = FEEDERS;
		t.snapshot([t.sensor(a), t.sensor(b), t.sensor(c)]);
		const shared = highlight(t, "House Finch", 5, "shared");
		const onlyB = highlight(t, "House Finch", 4, "only-b");
		const onlyC = highlight(t, "Carolina Chickadee", 3, "only-c");
		t.event(t.sensor(a, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [shared] }));
		t.event(t.sensor(b, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [shared, onlyB] }));
		t.event(t.sensor(c, { species_list: ["Carolina Chickadee"], thumbnails: THUMBS, highlights: [onlyC] }));

		const today = t.of("BIRDFY_TODAY").pop();
		assert.equal(today.totalVisitsToday, 3);
		assert.equal(today.speciesCount, 2);
		const finch = today.visitors.find((v) => v.name === "House Finch");
		assert.equal(finch.count, 2);
		assert.equal(finch.imageUrl, THUMBS["House Finch"]);
		assert.equal(today.date, "2026-10-01");
		// Only the genuinely new items alerted: shared (feeder A), onlyB, onlyC.
		assert.equal(t.of("BIRDFY_ALERT").length, 3);
	} finally {
		t.stop();
	}
});

// ── Midnight reset ──────────────────────────────────────────────────────────

test("counts reset at local midnight and yesterday's stale attributes are not read as new birds", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder)]);
		const yesterdayStart = t.dayStart();
		t.event(t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [highlight(t, "House Finch", 1, "a")] }));
		assert.equal(t.of("BIRDFY_TODAY").pop().totalVisitsToday, 1);
		t.clear();

		// Local midnight passes; the integration has not refreshed yet.
		t.clock.now = new Date(2026, 9, 2, 0, 0, 30).getTime();
		t.helper._haOnMidnight();
		const reset = t.of("BIRDFY_TODAY").pop();
		assert.equal(reset.totalVisitsToday, 0);
		assert.deepEqual(reset.visitors, []);
		assert.equal(reset.date, "2026-10-02");

		// Stale update still carrying yesterday's window: ignored.
		t.event({
			...t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS }),
			attributes: { ...t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS }).attributes, start_time: localIso(yesterdayStart) }
		});
		assert.equal(t.of("BIRDFY_ALERT").length, 0);
		assert.equal(t.of("BIRDFY_TODAY").pop().totalVisitsToday, 0);

		// Fresh window with the same species: it is a new day, so it alerts again.
		t.event(t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, last_detection: localIso(new Date(t.clock.now - MIN)) }));
		const alerts = t.of("BIRDFY_ALERT");
		assert.equal(alerts.length, 1);
		assert.equal(alerts[0].speciesVisitsToday, 1);
		assert.equal(alerts[0].totalVisitsToday, 1);
	} finally {
		t.stop();
	}
});

// ── Image-change detection (opt-in) ────────────────────────────────────────

test("an image entity tick is not a detection by default", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder)]);
		t.helper.ha.connectedAt = t.clock.now - (10 * MIN);
		t.event({ entity_id: feeder.imageEntity, state: "2026-10-01T12:00:00", attributes: { species: "House Finch", detection_time: "2026-10-01T11:59:00" } },
			{ entity_id: feeder.imageEntity, state: "2026-10-01T11:45:00", attributes: {} });
		assert.equal(t.of("BIRDFY_ALERT").length, 0);
	} finally {
		t.stop();
	}
});

test("with imageChangeDetection on, an unmatched image change is one detection; known or early ones are not", () => {
	const t = makeHa({ config: { imageChangeDetection: true } });
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder)]);
		const img = (state, attrs) => ({ entity_id: feeder.imageEntity, state, attributes: attrs });
		const prev = img("2026-10-01T11:45:00", {});

		// Right after connecting (HA restart ticks): ignored.
		t.helper.ha.connectedAt = t.clock.now - 5000;
		t.event(img("2026-10-01T11:50:00", { species: "House Finch", detection_time: "2026-10-01T11:49:00" }), prev);
		assert.equal(t.of("BIRDFY_ALERT").length, 0);

		t.helper.ha.connectedAt = t.clock.now - (10 * MIN);
		t.event(img("2026-10-01T11:59:00", { species: "House Finch", detection_time: "2026-10-01T11:58:00" }), prev);
		const alerts = t.of("BIRDFY_ALERT");
		assert.equal(alerts.length, 1);
		assert.equal(alerts[0].species, "House Finch");
		assert.equal(alerts[0].countSource, "detections");

		// Token rotation: same state value, no new detection.
		t.event(img("2026-10-01T11:59:00", { species: "House Finch", detection_time: "2026-10-01T11:58:00", access_token: "x" }), img("2026-10-01T11:59:00", {}));
		assert.equal(t.of("BIRDFY_ALERT").length, 1);
	} finally {
		t.stop();
	}
});

// ── maxAlertAge default ─────────────────────────────────────────────────────

test("maxAlertAge: unset resolves to 60 min in HA mode and 30 min in cloud mode; explicit values (including 30 min) are honored", () => {
	const t = makeHa({ config: { maxAlertAge: null } });
	try {
		const h = t.helper;
		for (const unset of [null, undefined, 0, "abc"]) {
			h.config.maxAlertAge = unset;
			assert.equal(h._maxAlertAge("homeassistant"), 60 * MIN);
			assert.equal(h._maxAlertAge("cloud"), 30 * MIN);
		}
		h.config.maxAlertAge = 30 * MIN;
		assert.equal(h._maxAlertAge("homeassistant"), 30 * MIN, "30 minutes is a legitimate HA choice");
		h.config.maxAlertAge = 10 * MIN;
		assert.equal(h._maxAlertAge("homeassistant"), 10 * MIN);
		assert.equal(h._maxAlertAge("cloud"), 10 * MIN);

		h.config.maxAlertAge = null;
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder)]);
		t.event(t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [highlight(t, "House Finch", 45, "a")] }));
		assert.equal(t.of("BIRDFY_ALERT").length, 1, "a 45 minute old highlight is announced under the 60 minute HA default");
	} finally {
		t.stop();
	}
});

test("cloud polling with maxAlertAge unset (null) still alerts on a fresh clip and skips an old one", async () => {
	const t = makeHa({ config: { source: "", maxAlertAge: null, sources: [] } });
	const { helper, sent } = t;
	helper.config = { maxAlertAge: null };
	const now = Date.now();
	helper.sources = [{
		api: {
			name: "Feeder",
			uuid: "null-age",
			getToday: async () => ({
				birdList: [],
				dataList: [
					{ detectObject: "Robin", createTime: now - (45 * MIN), fileUrl: "https://example.com/old.mp4", category: "x" },
					{ detectObject: "Cardinal", createTime: now - 1000, fileUrl: "https://example.com/new.mp4", category: "x" }
				]
			})
		},
		seen: new Set(), errorCount: 0, lastErrorLog: 0, lastValidityCheck: Date.now(), invalid: false,
		speciesDay: null, speciesSeen: new Set(), speciesPrimed: false, visitors: []
	}];
	await helper._pollAll();
	const alerts = sent.filter((n) => n.notification === "BIRDFY_ALERT");
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].payload.species, "Cardinal");
	t.stop();
});

// ── Auto-discovery ──────────────────────────────────────────────────────────

test("feeders are auto-discovered from sensor.*_bird_species and exclude the _count sensor", () => {
	const t = makeHa({ config: { feeders: [] } });
	try {
		const feeder = { speciesEntity: "sensor.birdfy_bird_feeder_bird_species", imageEntity: "image.birdfy_bird_feeder_last_bird" };
		const sensor = t.sensor(feeder);
		sensor.attributes.friendly_name = "Birdfy Bird Feeder Bird Species";
		t.snapshot([
			sensor,
			{ entity_id: "sensor.birdfy_bird_feeder_bird_species_count", state: "0", attributes: {} },
			{ entity_id: "sensor.birdfy_bird_feeder_last_bird_species", state: "House Finch", attributes: {} },
			{ entity_id: "sensor.birdfy_bird_feeder_new_species_today", state: "0", attributes: {} },
			{ entity_id: "image.birdfy_bird_feeder_last_bird", state: "2026-10-01T00:00:00", attributes: {} },
			{ entity_id: "sensor.unrelated", state: "1", attributes: {} }
		]);
		const feeders = t.helper.ha.feeders;
		assert.equal(feeders.length, 1);
		assert.equal(feeders[0].name, "Bird Feeder");
		assert.equal(feeders[0].imageEntity, "image.birdfy_bird_feeder_last_bird");
		assert.equal(feeders[0].lastSpeciesEntity, "sensor.birdfy_bird_feeder_last_bird_species");
	} finally {
		t.stop();
	}
});

test("no Birdfy sensors in HA reports a discovery haError (terminal) instead of staying silent", () => {
	const t = makeHa({ config: { feeders: [] } });
	try {
		t.snapshot([{ entity_id: "sensor.unrelated", state: "1", attributes: {} }]);
		const err = t.of("BIRDFY_STATUS").map((s) => s.haError).filter(Boolean)[0];
		assert.ok(err);
		assert.equal(err.kind, "discovery");
		assert.equal(err.terminal, true);
		assert.equal(typeof err.since, "number");
		assert.match(err.message, /No Birdfy sensors found/);
		assert.equal(t.of("BIRDFY_ERROR").length, 0);
	} finally {
		t.stop();
	}
});

// ── Config validation ───────────────────────────────────────────────────────

test("homeassistant mode without haUrl/haToken reports a configError, sends READY, and does not connect", () => {
	const t = makeHa({ config: { haUrl: "", haToken: "" } });
	try {
		const status = t.of("BIRDFY_STATUS").find((s) => s.configError);
		assert.ok(status);
		assert.match(status.configError, /haUrl/);
		assert.match(status.configError, /haToken/);
		assert.equal(status.source, "homeassistant");
		assert.equal(t.of("BIRDFY_READY").length, 1);
		assert.equal(t.connects(), 0);
	} finally {
		t.stop();
	}
});

test("a valid homeassistant config reports source and connection state without a configError", () => {
	const t = makeHa();
	try {
		const status = t.of("BIRDFY_STATUS")[0];
		assert.equal(status.configError, null);
		assert.equal(status.source, "homeassistant");
		assert.equal(status.connected, false);
		assert.equal(t.of("BIRDFY_READY").length, 1);
	} finally {
		t.stop();
	}
});

// ── Token never reaches the front end ───────────────────────────────────────

test("the HA token never appears in any notification sent to the front end", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([
			t.sensor(feeder),
			{ entity_id: feeder.imageEntity, state: "2026-10-01T11:00:00", attributes: { species: "House Finch", entity_picture: "/api/image_proxy/x?token=abc", access_token: "abc" } }
		]);
		t.event(t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [highlight(t, "House Finch", 1, "a")] }));
		t.helper._haSetError("connection", "Home Assistant is unreachable; retrying.", false);
		t.helper._haClearError("connection");
		assert.ok(t.sent.length > 5, "expected a realistic set of notifications");
		assert.equal(JSON.stringify(t.sent).includes(TOKEN), false);
	} finally {
		t.stop();
	}
});

test("a payload that would contain the token is dropped rather than sent", () => {
	const t = makeHa();
	try {
		const feeder = FEEDERS[0];
		t.snapshot([t.sensor(feeder)]);
		t.clear();
		const leaky = `https://blob.example.test/${TOKEN}.jpg`;
		t.event(t.sensor(feeder, { species_list: ["House Finch"], thumbnails: { "House Finch": leaky }, highlights: [highlight(t, "House Finch", 1, "a")] }));
		assert.equal(JSON.stringify(t.sent).includes(TOKEN), false);
		assert.equal(t.of("BIRDFY_ALERT").length, 0);
	} finally {
		t.stop();
	}
});

// ── Image proxy ─────────────────────────────────────────────────────────────

/**
 * @param {Function} handler HTTP request handler standing in for Home Assistant.
 * @returns {Promise<http.Server>} A listening server on an ephemeral port.
 */
function listen (handler) {
	return new Promise((resolve) => {
		const server = http.createServer(handler);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

test("image proxy streams the HA image using the Bearer token server-side and never returns the token", async () => {
	const seen = [];
	const fakeHa = await listen((req, res) => {
		seen.push({ url: req.url, auth: req.headers.authorization });
		if (req.headers.authorization !== `Bearer ${TOKEN}`) {
			res.writeHead(401).end();
			return;
		}
		res.writeHead(200, { "Content-Type": "image/jpeg", "X-Secret": TOKEN });
		res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
	});
	const t = makeHa({ config: { haUrl: `http://127.0.0.1:${fakeHa.address().port}` } });
	const app = express();
	t.helper.expressApp = app;
	t.helper._haRegisterImageRoute();
	const mirror = await listen(app);
	try {
		const base = `http://127.0.0.1:${mirror.address().port}`;
		const ok = await fetch(`${base}/birdfy/image/0?t=1`);
		assert.equal(ok.status, 200);
		assert.equal(ok.headers.get("content-type"), "image/jpeg");
		assert.equal(ok.headers.get("x-secret"), null, "upstream headers are not forwarded");
		assert.equal((await ok.arrayBuffer()).byteLength, 4);
		assert.deepEqual(seen[0], { url: "/api/image_proxy/image.birdfy_bird_feeder_last_bird", auth: `Bearer ${TOKEN}` });

		assert.equal((await fetch(`${base}/birdfy/image/9`)).status, 404);
		assert.equal((await fetch(`${base}/birdfy/image/abc`)).status, 404);
	} finally {
		mirror.close();
		fakeHa.close();
		t.stop();
	}
});

test("image proxy answers 502 when HA fails or returns a non-image, without leaking details", async () => {
	const fakeHa = await listen((req, res) => {
		res.writeHead(500, { "Content-Type": "text/plain" }).end(`boom ${TOKEN}`);
	});
	const t = makeHa({ config: { haUrl: `http://127.0.0.1:${fakeHa.address().port}` } });
	const app = express();
	t.helper.expressApp = app;
	t.helper._haRegisterImageRoute();
	const mirror = await listen(app);
	try {
		const res = await fetch(`http://127.0.0.1:${mirror.address().port}/birdfy/image/0`);
		assert.equal(res.status, 502);
		assert.equal((await res.text()).includes(TOKEN), false);
	} finally {
		mirror.close();
		fakeHa.close();
		t.stop();
	}
});

// ── WebSocket lifecycle (against a fake HA) ────────────────────────────────

/**
 * @param {Function} cond Predicate to wait for.
 * @param {number} ms Timeout.
 * @returns {Promise<void>} Resolves when cond is true; rejects on timeout.
 */
async function waitFor (cond, ms = 3000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("timed out waiting for condition");
}

/**
 * A minimal Home Assistant WebSocket API.
 * @param {object} opts Behaviour switches.
 * @returns {Promise<object>} The fake server with its server, connection count and sockets.
 */
function fakeHaServer (opts = {}) {
	return new Promise((resolve) => {
		const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/api/websocket" });
		const info = { wss, connections: 0, sockets: [], received: [], states: opts.states || [] };
		wss.on("connection", (socket) => {
			info.connections += 1;
			info.sockets.push(socket);
			socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.9.0" }));
			socket.on("message", (data) => {
				const msg = JSON.parse(data.toString());
				info.received.push(msg.type);
				if (msg.type === "auth") {
					if (msg.access_token === TOKEN && !opts.rejectAuth) {
						socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.9.0" }));
					} else {
						socket.send(JSON.stringify({ type: "auth_invalid", message: "Invalid access token" }));
						socket.close();
					}
				} else if (msg.type === "get_states") {
					socket.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: info.states }));
				} else if (msg.type === "ping" && !opts.ignorePing) {
					socket.send(JSON.stringify({ id: msg.id, type: "pong" }));
				}
			});
		});
		wss.on("listening", () => resolve(info));
	});
}

test("WebSocket: authenticates, reads the snapshot, and turns a state_changed event into an alert", async () => {
	const probe = makeHa();
	const feeder = FEEDERS[0];
	const initial = probe.sensor(feeder);
	probe.stop();
	const server = await fakeHaServer({ states: [initial] });
	const t = makeHa({ config: { haUrl: `http://127.0.0.1:${server.wss.address().port}`, heartbeatInterval: 40 } });
	t.helper._haConnect = NodeHelperClass.prototype._haConnect; // use the real connection
	t.helper._haStart();
	try {
		await waitFor(() => t.helper.ha.snapshotDone);
		assert.deepEqual(server.received.slice(0, 3), ["auth", "get_states", "subscribe_events"]);
		assert.ok(t.of("BIRDFY_STATUS").some((s) => s.connected === true));

		const item = highlight(t, "House Finch", 1, "ws");
		const next = t.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [item] });
		server.sockets[0].send(JSON.stringify({ id: 2, type: "event", event: { event_type: "state_changed", data: { entity_id: feeder.speciesEntity, new_state: next, old_state: initial } } }));
		await waitFor(() => t.of("BIRDFY_ALERT").length === 1);
		assert.equal(t.of("BIRDFY_ALERT")[0].species, "House Finch");

		await waitFor(() => server.received.includes("ping"));
		assert.equal(JSON.stringify(t.sent).includes(TOKEN), false);
	} finally {
		t.stop();
		server.wss.close();
	}
});

test("WebSocket: a rejected token is terminal (no reconnect) and is reported", async () => {
	const server = await fakeHaServer({ rejectAuth: true });
	const t = makeHa({ config: { haUrl: `http://127.0.0.1:${server.wss.address().port}`, reconnectInterval: 20 } });
	t.helper._haConnect = NodeHelperClass.prototype._haConnect;
	t.helper._haStart();
	try {
		await waitFor(() => t.of("BIRDFY_STATUS").some((x) => x.haError));
		await new Promise((r) => setTimeout(r, 250));
		assert.equal(server.connections, 1, "must not retry with a rejected token");
		const err = t.of("BIRDFY_STATUS").map((x) => x.haError).filter(Boolean)[0];
		assert.equal(err.kind, "auth");
		assert.equal(err.terminal, true);
		assert.match(err.message, /rejected the access token/);
		const lost = t.of("BIRDFY_STATUS").filter((x) => x.connected === false && "retrying" in x && !("configError" in x));
		assert.ok(lost.length > 0 && lost.every((x) => x.retrying === false), "no 'reconnecting' after a terminal auth failure");
		assert.equal(t.helper.ha.reconnectTimer, null);
		assert.equal(JSON.stringify(t.sent).includes(TOKEN), false);
	} finally {
		t.stop();
		server.wss.close();
	}
});

test("WebSocket: reconnects after the connection drops and re-reads the snapshot", async () => {
	const server = await fakeHaServer({});
	const t = makeHa({ config: { haUrl: `http://127.0.0.1:${server.wss.address().port}`, reconnectInterval: 20 } });
	t.helper._haConnect = NodeHelperClass.prototype._haConnect;
	t.helper._haStart();
	try {
		await waitFor(() => t.helper.ha.snapshotDone);
		server.sockets[0].terminate();
		await waitFor(() => server.connections === 2 && t.helper.ha.snapshotDone);
		assert.ok(t.of("BIRDFY_STATUS").some((s) => s.connected === false));
	} finally {
		t.stop();
		server.wss.close();
	}
});

test("WebSocket: a missing pong forces a reconnect", async () => {
	const server = await fakeHaServer({ ignorePing: true });
	const t = makeHa({ config: { haUrl: `http://127.0.0.1:${server.wss.address().port}`, heartbeatInterval: 30, reconnectInterval: 20 } });
	t.helper._haConnect = NodeHelperClass.prototype._haConnect;
	t.helper._haStart();
	try {
		await waitFor(() => server.connections >= 2, 4000);
	} finally {
		t.stop();
		server.wss.close();
	}
});

test("pure helpers: species stem, URL normalisation, generic species", () => {
	const { speciesStem, normaliseHaUrl, cleanSpecies, parseLocalIso } = NodeHelperClass.prototype._testables;
	assert.equal(speciesStem("sensor.birdfy_bird_feeder_bird_species"), "birdfy_bird_feeder");
	assert.equal(speciesStem("sensor.birdfy_bird_feeder_bird_species_count"), null);
	assert.equal(speciesStem("sensor.birdfy_bird_feeder_last_bird_species"), null);
	assert.equal(normaliseHaUrl("https://ha.example.test:8123/"), "https://ha.example.test:8123");
	assert.equal(normaliseHaUrl("ftp://x"), null);
	assert.equal(normaliseHaUrl(""), null);
	assert.equal(cleanSpecies(" BIRD "), null);
	assert.equal(cleanSpecies(" House Finch "), "House Finch");
	assert.equal(parseLocalIso("2026-10-01T23:59:59.999000"), new Date(2026, 9, 1, 23, 59, 59, 999).getTime());
});

// ── Error reporting, TODAY countSource, config refresh, token sources, proxy hardening ──

test("a lost connection is reported as a non-terminal connection haError after repeated failures, and cleared on auth_ok", () => {
	const t = makeHa();
	try {
		const ha = t.helper.ha;
		t.clear();
		for (let i = 0; i < 3; i++) t.helper._haConnectionLost();
		clearTimeout(ha.reconnectTimer);
		const err = t.of("BIRDFY_STATUS").map((x) => x.haError).filter(Boolean).pop();
		assert.equal(err.kind, "connection");
		assert.equal(err.terminal, false);
		assert.equal(t.of("BIRDFY_STATUS").find((x) => x.connected === false).retrying, true);
		const since = err.since;
		t.clock.now += 5 * MIN;
		t.helper._haConnectionLost();
		clearTimeout(ha.reconnectTimer);
		t.helper._haSetError("connection", "Home Assistant is unreachable; retrying.", false);
		assert.equal(ha.errors.connection.since, since, "since is the first-seen time");

		t.clear();
		t.helper._haHandleMessage(JSON.stringify({ type: "auth_ok", ha_version: "x" }));
		assert.equal(t.of("BIRDFY_STATUS").some((x) => x.haError === null), true);
	} finally {
		t.stop();
	}
});

test("BIRDFY_TODAY carries countSource: highlights, detections or mixed", () => {
	const t = makeHa();
	try {
		const [a, b] = FEEDERS;
		t.snapshot([t.sensor(a), t.sensor(b)]);
		t.event(t.sensor(a, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [highlight(t, "House Finch", 1, "a")] }));
		let today = t.of("BIRDFY_TODAY").pop();
		assert.equal(today.countSource, "highlights");
		assert.equal(today.visitors[0].countSource, "highlights");

		t.event(t.sensor(b, { species_list: ["Carolina Chickadee"], thumbnails: THUMBS }));
		today = t.of("BIRDFY_TODAY").pop();
		assert.equal(today.countSource, "mixed");
		assert.equal(today.visitors.find((v) => v.name === "Carolina Chickadee").countSource, "detections");
	} finally {
		t.stop();
	}
});

test("BIRDFY_TODAY countSource is null with no visitors and detections when only the fallback applies", () => {
	const t = makeHa();
	try {
		t.snapshot([t.sensor(FEEDERS[0])]);
		assert.equal(t.of("BIRDFY_TODAY").pop().countSource, null);
		t.event(t.sensor(FEEDERS[0], { species_list: ["House Finch"], thumbnails: THUMBS }));
		assert.equal(t.of("BIRDFY_TODAY").pop().countSource, "detections");
	} finally {
		t.stop();
	}
});

test("resending the same config refreshes ha.cfg so changed options take effect", () => {
	const t = makeHa();
	try {
		const next = { ...t.helper.config, imageChangeDetection: true, haDebounceMs: 0 };
		t.helper.socketNotificationReceived("BIRDFY_CONFIG", next);
		assert.equal(t.connects(), 1);
		assert.equal(t.helper.ha.cfg, t.helper.config);
		assert.equal(t.helper.ha.cfg.imageChangeDetection, true);
	} finally {
		t.stop();
	}
});

test("token sources: haToken beats haTokenFile beats BIRDFY_HA_TOKEN; none gives a configError", () => {
	const file = path.join(os.tmpdir(), `birdfy-token-${process.pid}.txt`);
	fs.writeFileSync(file, "FILE-TOKEN\n");
	const saved = process.env.BIRDFY_HA_TOKEN;
	process.env.BIRDFY_HA_TOKEN = "ENV-TOKEN";
	try {
		const t = makeHa({ config: { haToken: "CFG-TOKEN", haTokenFile: file } });
		assert.equal(t.helper.ha.token, "CFG-TOKEN");
		t.stop();

		const f = makeHa({ config: { haToken: "", haTokenFile: file } });
		assert.equal(f.helper.ha.token, "FILE-TOKEN");
		f.stop();

		const missingFile = makeHa({ config: { haToken: "", haTokenFile: `${file}.missing` } });
		assert.equal(missingFile.helper.ha.token, "ENV-TOKEN");
		missingFile.stop();

		const e = makeHa({ config: { haToken: "" } });
		assert.equal(e.helper.ha.token, "ENV-TOKEN");
		assert.equal(JSON.stringify(e.sent).includes("ENV-TOKEN"), false);
		e.stop();

		delete process.env.BIRDFY_HA_TOKEN;
		const none = makeHa({ config: { haToken: "" } });
		const status = none.of("BIRDFY_STATUS").find((x) => x.configError);
		assert.match(status.configError, /haTokenFile/);
		assert.equal(none.connects(), 0);
		none.stop();
	} finally {
		if (saved === undefined) delete process.env.BIRDFY_HA_TOKEN;
		else process.env.BIRDFY_HA_TOKEN = saved;
		fs.rmSync(file, { force: true });
	}
});

test("image proxy only passes jpeg/png/webp/gif, sets nosniff, and refuses SVG", async () => {
	let type = "image/png";
	const fakeHa = await listen((req, res) => {
		res.writeHead(200, { "Content-Type": type });
		res.end("x");
	});
	const t = makeHa({ config: { haUrl: `http://127.0.0.1:${fakeHa.address().port}` } });
	const app = express();
	t.helper.expressApp = app;
	t.helper._haRegisterImageRoute();
	const mirror = await listen(app);
	try {
		const url = `http://127.0.0.1:${mirror.address().port}/birdfy/image/0`;
		for (const ok of ["image/jpeg", "image/png", "image/webp", "image/gif"]) {
			type = ok;
			const res = await fetch(url);
			assert.equal(res.status, 200, ok);
			assert.equal(res.headers.get("x-content-type-options"), "nosniff");
			await res.arrayBuffer();
		}
		for (const bad of ["image/svg+xml", "text/html", "image/x-icon"]) {
			type = bad;
			const res = await fetch(url);
			assert.equal(res.status, 502, bad);
			await res.arrayBuffer();
		}
	} finally {
		mirror.close();
		fakeHa.close();
		t.stop();
	}
});

test("a reload (same config resent) after a terminal error shows that error, not reconnecting", () => {
	const t = makeHa();
	try {
		// Terminal auth failure.
		t.helper._haHandleMessage(JSON.stringify({ type: "auth_invalid", message: "bad" }));
		t.clear();
		t.helper.socketNotificationReceived("BIRDFY_CONFIG", t.helper.config);
		let status = t.of("BIRDFY_STATUS")[0];
		assert.equal(status.connected, false);
		assert.equal(status.retrying, false);
		assert.equal(status.haError.kind, "auth");
		assert.equal(status.haError.terminal, true);
		assert.equal(t.connects(), 1, "no reconnect attempt on reload");

		// Terminal discovery failure.
		t.helper.ha.errors = {};
		t.helper.ha.authFailed = false;
		t.helper._haSetError("discovery", "No Birdfy sensors found in Home Assistant (expected sensor.*_bird_species).", true);
		t.clear();
		t.helper.socketNotificationReceived("BIRDFY_CONFIG", t.helper.config);
		status = t.of("BIRDFY_STATUS")[0];
		assert.equal(status.haError.kind, "discovery");
		assert.equal(status.retrying, false);

		// Healthy: no error, retrying true.
		t.helper.ha.errors = {};
		t.helper.ha.connected = true;
		t.clear();
		t.helper.socketNotificationReceived("BIRDFY_CONFIG", t.helper.config);
		status = t.of("BIRDFY_STATUS")[0];
		assert.equal(status.connected, true);
		assert.equal(status.retrying, true);
		assert.equal(status.haError, null);
	} finally {
		t.stop();
	}
});

test("catch-up alerts from the startup snapshot carry replay:true; live alerts do not", () => {
	const first = makeHa();
	const feeder = FEEDERS[0];
	first.snapshot([first.sensor(feeder)]);
	first.helper._haShutdown();

	const second = makeHa({ statePath: first.statePath, now: first.clock.now });
	try {
		second.snapshot([second.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [highlight(second, "House Finch", 10, "missed")] })]);
		const catchUp = second.of("BIRDFY_ALERT");
		assert.equal(catchUp.length, 1);
		assert.equal(catchUp[0].replay, true);

		second.event(second.sensor(feeder, { species_list: ["House Finch"], thumbnails: THUMBS, highlights: [highlight(second, "House Finch", 10, "missed"), highlight(second, "House Finch", 1, "live")] }));
		const live = second.of("BIRDFY_ALERT")[1];
		assert.ok(live);
		assert.equal("replay" in live, false);
	} finally {
		second.stop();
	}
});

test("the auth error names the token source in use and never the token", () => {
	const file = path.join(os.tmpdir(), `birdfy-src-${process.pid}.txt`);
	fs.writeFileSync(file, "FILE-SECRET\n");
	const saved = process.env.BIRDFY_HA_TOKEN;
	try {
		const msgFor = (config, env) => {
			if (env === undefined) delete process.env.BIRDFY_HA_TOKEN;
			else process.env.BIRDFY_HA_TOKEN = env;
			const t = makeHa({ config });
			t.helper._haHandleMessage(JSON.stringify({ type: "auth_invalid", message: "x" }));
			const msg = t.of("BIRDFY_STATUS").map((x) => x.haError).filter(Boolean)[0].message;
			t.stop();
			return msg;
		};
		assert.match(msgFor({}, undefined), /check haToken\)/);
		const viaFile = msgFor({ haToken: "", haTokenFile: file }, undefined);
		assert.ok(viaFile.includes(`haTokenFile (${path.basename(file)})`));
		assert.equal(viaFile.includes(os.tmpdir()) || viaFile.includes("FILE-SECRET"), false);
		const viaEnv = msgFor({ haToken: "" }, "ENV-SECRET");
		assert.match(viaEnv, /BIRDFY_HA_TOKEN environment variable/);
		assert.doesNotMatch(viaEnv, /ENV-SECRET/);
	} finally {
		if (saved === undefined) delete process.env.BIRDFY_HA_TOKEN;
		else process.env.BIRDFY_HA_TOKEN = saved;
		fs.rmSync(file, { force: true });
	}
});
