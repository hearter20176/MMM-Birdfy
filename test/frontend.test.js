"use strict";

// MMM-Birdfy.js is written against MagicMirror's browser globals
// (Module.register, Log, document). This file stubs the minimum needed to
// load the module definition and exercise its plain-JS logic (error
// bookkeeping, getDom's element tree) without a real browser or the
// MagicMirror core bundle.

const { test, mock, afterEach } = require("node:test");
const assert = require("node:assert/strict");

/**
 * A minimal stand-in for a DOM element: just enough for createElement/
 * appendChild/className/textContent, which is all MMM-Birdfy.js's DOM
 * building uses.
 */
class FakeElement {
	constructor (tagName) {
		this.tagName = tagName;
		this.className = "";
		this.textContent = "";
		this.children = [];
		this.style = {};
		this.parent = null;
	}

	appendChild (child) {
		child.parent = this;
		this.children.push(child);
		return child;
	}

	replaceWith (other) {
		if (!this.parent) return;
		const index = this.parent.children.indexOf(this);
		other.parent = this.parent;
		this.parent.children[index] = other;
		this.parent = null;
	}

	remove () {}
}

/**
 * Depth-first search for elements whose class list contains `cls`.
 * @param {FakeElement} root Element to search from.
 * @param {string} cls A single class name.
 * @returns {FakeElement[]} Matching elements, in document order.
 */
function findAll (root, cls) {
	const found = [];
	if (root.className.split(/\s+/).includes(cls)) found.push(root);
	for (const child of root.children) found.push(...findAll(child, cls));
	return found;
}

/**
 * Concatenate all text in a subtree.
 * @param {FakeElement} root Element to read.
 * @returns {string} The subtree's text, space separated.
 */
function textOf (root) {
	return [root.textContent, ...root.children.map(textOf)].filter(Boolean).join(" ");
}

global.document = {
	createElement: (tagName) => new FakeElement(tagName)
};

let moduleDefinition = null;
global.Module = {
	register (name, definition) {
		moduleDefinition = definition;
	}
};
global.Log = {
	info () {},
	warn () {},
	error () {}
};

// Loading the file triggers Module.register(...) synchronously, capturing
// the definition object above.
require("../MMM-Birdfy");

/**
 * Build a bare module instance: the plain-object definition plus the bits
 * Module.register()/MagicMirror core would normally supply (config,
 * updateDom, sendSocketNotification), then run start() on it.
 * @param {object} configOverrides Config keys to override the defaults with.
 * @returns {object} The initialised module instance.
 */
function makeModule (configOverrides = {}) {
	const mod = Object.assign({}, moduleDefinition);
	mod.data = { header: "" };
	mod.config = Object.assign({}, moduleDefinition.defaults, configOverrides);
	mod.sendSocketNotification = () => {};
	mod.sent = [];
	mod.sendNotification = (name, payload) => {
		mod.sent.push({ name, payload });
	};
	mod.domUpdates = 0;
	mod.updateDom = () => {
		mod.domUpdates += 1;
	};
	moduleDefinition.start.call(mod);
	created.push(mod);
	return mod;
}

// Every module built by makeModule(); afterEach clears any alert timer a test
// left armed, so no real displayDuration timeout keeps the test run alive.
const created = [];
afterEach(() => {
	for (const mod of created.splice(0)) moduleDefinition.stop.call(mod);
});

test("frontend module definition loaded via Module.register", () => {
	assert.ok(moduleDefinition, "expected MMM-Birdfy.js to call Module.register");
	assert.equal(typeof moduleDefinition.getDom, "function");
	assert.equal(typeof moduleDefinition.socketNotificationReceived, "function");
});

// ── Item 1: first-seen timestamp is kept, source name is shown ─────────────

test("BIRDFY_ERROR keeps the first-seen timestamp for a key across repeated errors", () => {
	const mod = makeModule();
	const originalNow = Date.now;
	let now = 1_700_000_000_000; // arbitrary fixed instant
	Date.now = () => now;

	try {
		moduleDefinition.socketNotificationReceived.call(mod, "BIRDFY_ERROR", {
			key: "uuid-backyard",
			message: "Backyard: network down",
			name: "Backyard"
		});
		const firstAt = mod.errors["uuid-backyard"].at;
		assert.equal(firstAt, now);

		// Simulate node_helper's 15-minute outage-summary resend, twice over.
		now += 30 * 60 * 1000;
		moduleDefinition.socketNotificationReceived.call(mod, "BIRDFY_ERROR", {
			key: "uuid-backyard",
			message: "Backyard: network down (3 failed polls so far)",
			name: "Backyard"
		});

		assert.equal(mod.errors["uuid-backyard"].at, firstAt, "the timestamp must not drift forward on a repeated error for the same key");
	} finally {
		Date.now = originalNow;
	}
});

test("getDom labels each failing source by name so two outages are distinguishable", () => {
	const mod = makeModule();
	mod.loaded = true;

	moduleDefinition.socketNotificationReceived.call(mod, "BIRDFY_ERROR", {
		key: "uuid-backyard",
		message: "Backyard: network down",
		name: "Backyard"
	});
	moduleDefinition.socketNotificationReceived.call(mod, "BIRDFY_ERROR", {
		key: "uuid-porch",
		message: "Porch: network down",
		name: "Porch"
	});

	const wrapper = moduleDefinition.getDom.call(mod);
	const errorLines = wrapper.children
		.filter((child) => child.className === "birdfy-error")
		.map((child) => child.textContent);

	assert.equal(errorLines.length, 2, "expected one line per failing source");
	assert.ok(errorLines.some((text) => text.includes("Backyard")), "expected the Backyard source to be named");
	assert.ok(errorLines.some((text) => text.includes("Porch")), "expected the Porch source to be named");
	assert.notEqual(errorLines[0], errorLines[1], "two different sources must not render identical lines");
});

test("getDom shows the webhook's own message verbatim, not the generic source wording", () => {
	const mod = makeModule();
	mod.loaded = true;

	moduleDefinition.socketNotificationReceived.call(mod, "BIRDFY_ERROR", {
		key: "webhook",
		message: "Webhook port 8765 in use"
	});

	const wrapper = moduleDefinition.getDom.call(mod);
	const errorLines = wrapper.children
		.filter((child) => child.className === "birdfy-error")
		.map((child) => child.textContent);

	assert.deepEqual(errorLines, ["Webhook port 8765 in use"]);
});

// ── New alert card ─────────────────────────────────────────────────────────

const ALERT = {
	id: "a1",
	species: "Carolina Chickadee",
	feeder: "Feeder",
	timestamp: 1_700_000_000_000,
	imageUrl: "https://example.test/chickadee.jpg",
	videoUrl: null,
	speciesVisitsToday: 4,
	totalVisitsToday: 11,
	countSource: "highlights"
};

/**
 * Send a socket notification to a module instance.
 * @param {object} mod The module instance.
 * @param {string} name Notification name.
 * @param {object} payload Notification payload.
 */
function send (mod, name, payload) {
	moduleDefinition.socketNotificationReceived.call(mod, name, payload);
}

/**
 * Render the module.
 * @param {object} mod The module instance.
 * @returns {FakeElement} The rendered wrapper.
 */
function render (mod) {
	return moduleDefinition.getDom.call(mod);
}

test("alert card shows species, both visit counts, and says they come from highlights", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_ALERT", ALERT);
	const wrapper = render(mod);
	const text = textOf(wrapper);

	assert.ok(wrapper.className.includes("birdfy-card"));
	assert.equal(findAll(wrapper, "birdfy-species-name")[0].textContent, "Carolina Chickadee");
	assert.ok(text.includes("4 visits today"), text);
	assert.ok(text.includes("11 total visits today"), text);
	assert.ok(text.includes("Counts from Birdfy highlights"), text);
	assert.ok(text.includes("Feeder"));
});

test("alert card uses singular wording for one visit", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_ALERT", { ...ALERT, speciesVisitsToday: 1, totalVisitsToday: 1 });
	const text = textOf(render(mod));
	assert.ok(text.includes("1 visit today"), text);
	assert.ok(text.includes("1 total visit today"), text);
	assert.ok(!text.includes("1 visits"), text);
});

test("alert card says when counts are derived from detections, and omits absent counts", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_ALERT", { ...ALERT, countSource: "detections" });
	assert.ok(textOf(render(mod)).includes("detections seen by this mirror"));

	const bare = makeModule();
	send(bare, "BIRDFY_ALERT", { id: "b", species: "Blue Jay", timestamp: 1_700_000_000_000 });
	const wrapper = render(bare);
	assert.equal(findAll(wrapper, "birdfy-stats").length, 0);
	assert.ok(!textOf(wrapper).includes("highlights"));
});

test("card width and image aspect come from config, with safe fallbacks", () => {
	const mod = makeModule({ cardWidth: 440, imageAspect: "16/10" });
	send(mod, "BIRDFY_ALERT", ALERT);
	const wrapper = render(mod);
	assert.equal(wrapper.style.width, "440px");
	assert.equal(findAll(wrapper, "birdfy-media-frame")[0].style.aspectRatio, "16/10");

	const bad = makeModule({ cardWidth: "wide", imageAspect: "url(x)" });
	send(bad, "BIRDFY_ALERT", ALERT);
	const badWrapper = render(bad);
	assert.equal(badWrapper.style.width, "560px");
	assert.equal(findAll(badWrapper, "birdfy-media-frame")[0].style.aspectRatio, "1/1");
});

test("a broken still image is replaced by the placeholder", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_ALERT", ALERT);
	const frame = findAll(render(mod), "birdfy-media-frame")[0];
	const img = frame.children[0];
	assert.equal(img.tagName, "img");
	img.onerror();
	assert.ok(frame.children[0].className.includes("birdfy-media-fallback"));
});

test("a broken clip falls back to the still, then to the placeholder", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_ALERT", { ...ALERT, videoUrl: "https://example.test/clip.mp4" });
	const frame = findAll(render(mod), "birdfy-media-frame")[0];
	const video = frame.children[0];
	assert.equal(video.tagName, "video");
	assert.equal(video.poster, ALERT.imageUrl);
	video.onerror();
	const img = frame.children[0];
	assert.equal(img.tagName, "img");
	assert.equal(img.src, ALERT.imageUrl);
	img.onerror();
	assert.ok(frame.children[0].className.includes("birdfy-media-fallback"));
});

test("an alert with no image at all still renders the placeholder frame", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_ALERT", { ...ALERT, imageUrl: null });
	const frame = findAll(render(mod), "birdfy-media-frame")[0];
	assert.ok(frame.children[0].className.includes("birdfy-media-fallback"));
});

test("idle view lists the day's visitors with counts and the total", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_READY", {});
	send(mod, "BIRDFY_TODAY", {
		visitors: [
			{ name: "House Finch", count: 5, imageUrl: "https://example.test/f.jpg" },
			{ name: "Carolina Chickadee", count: 1, imageUrl: null }
		],
		totalVisitsToday: 6,
		speciesCount: 2,
		date: "2026-10-01"
	});
	const wrapper = render(mod);
	const text = textOf(wrapper);

	assert.equal(findAll(wrapper, "birdfy-visitor").length, 2);
	assert.ok(text.includes("House Finch"));
	assert.ok(text.includes("5 visits"));
	assert.ok(text.includes("1 visit"));
	assert.ok(text.includes("6 total visits today"), text);
	assert.ok(text.includes("Birdfy highlights"));
});

test("idle total falls back to the sum of counts, and a broken thumbnail gets the placeholder", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_TODAY", {
		visitors: [{ name: "A", count: 2, imageUrl: "https://example.test/a.jpg" }, { name: "B", count: 3 }]
	});
	const wrapper = render(mod);
	assert.ok(textOf(wrapper).includes("5 total visits today"));

	const thumb = findAll(wrapper, "birdfy-visitor-thumb")[0];
	thumb.children[0].onerror();
	assert.ok(thumb.children[0].className.includes("birdfy-media-fallback"));
});

test("idle view caps the list at maxVisitors and reports the overflow", () => {
	const mod = makeModule({ maxVisitors: 2 });
	send(mod, "BIRDFY_TODAY", {
		visitors: [1, 2, 3, 4].map((n) => ({ name: `Bird ${n}`, count: 1 })),
		totalVisitsToday: 4
	});
	const wrapper = render(mod);
	assert.equal(findAll(wrapper, "birdfy-visitor").length, 2);
	assert.equal(findAll(wrapper, "birdfy-more")[0].textContent, "+2 more");
});

test("midnight reset: an empty BIRDFY_TODAY returns the idle view to the no-visitors message", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_TODAY", { visitors: [{ name: "A", count: 2 }], totalVisitsToday: 2 });
	send(mod, "BIRDFY_TODAY", { visitors: [], totalVisitsToday: 0, speciesCount: 0 });
	assert.ok(textOf(render(mod)).includes("No visitors yet today"));
});

test("a malformed visitor list cannot make getDom throw", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_TODAY", { visitors: [null], totalVisitsToday: 1 });
	let wrapper;
	assert.doesNotThrow(() => {
		wrapper = render(mod);
	});
	assert.ok(textOf(wrapper).includes("Birdfy display error"));
});

test("Home Assistant disconnect is shown as a diagnostic line and clears on reconnect", () => {
	const mod = makeModule({ showWhenIdle: false });
	send(mod, "BIRDFY_STATUS", { source: "homeassistant", connected: false });
	assert.ok(textOf(render(mod)).includes("Home Assistant disconnected"));
	send(mod, "BIRDFY_STATUS", { source: "homeassistant", connected: true });
	assert.equal(render(mod).children.length, 0);
});

// ── Alert timing across a rotating page ────────────────────────────────────

test("an alert that arrives while the page is hidden is timed from when it is first visible", () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	try {
		const mod = makeModule({ displayDuration: 60000 });
		moduleDefinition.suspend.call(mod);
		send(mod, "BIRDFY_ALERT", ALERT);

		mock.timers.tick(10 * 60 * 1000);
		assert.ok(mod.alert, "must still be waiting after 10 minutes hidden");

		moduleDefinition.resume.call(mod);
		mock.timers.tick(59000);
		assert.ok(mod.alert, "must still show 59 s after becoming visible");
		mock.timers.tick(1500);
		assert.equal(mod.alert, null, "must dismiss after displayDuration of visible time");
	} finally {
		mock.timers.reset();
	}
});

test("suspending mid-alert pauses the countdown and resume continues with the remainder", () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	try {
		const mod = makeModule({ displayDuration: 60000 });
		send(mod, "BIRDFY_ALERT", ALERT);
		mock.timers.tick(20000);
		moduleDefinition.suspend.call(mod);
		mock.timers.tick(5 * 60 * 1000);
		assert.ok(mod.alert);

		moduleDefinition.resume.call(mod);
		mock.timers.tick(39000);
		assert.ok(mod.alert, "about 40 s should remain");
		mock.timers.tick(1500);
		assert.equal(mod.alert, null);
	} finally {
		mock.timers.reset();
	}
});

test("a newer alert replaces the current one and restarts the full duration", () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	try {
		const mod = makeModule({ displayDuration: 60000 });
		send(mod, "BIRDFY_ALERT", ALERT);
		mock.timers.tick(50000);
		send(mod, "BIRDFY_ALERT", { ...ALERT, id: "a2", species: "House Finch" });
		mock.timers.tick(20000);
		assert.equal(mod.alert.species, "House Finch", "old timer must not dismiss the new alert");
		mock.timers.tick(41000);
		assert.equal(mod.alert, null);
	} finally {
		mock.timers.reset();
	}
});

test("a re-sent alert with the same id is not shown again", () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
	try {
		const mod = makeModule({ displayDuration: 1000 });
		send(mod, "BIRDFY_ALERT", ALERT);
		mock.timers.tick(1500);
		assert.equal(mod.alert, null);
		send(mod, "BIRDFY_ALERT", ALERT);
		assert.equal(mod.alert, null);
	} finally {
		mock.timers.reset();
	}
});

// ── pageOnAlert ────────────────────────────────────────────────────────────

test("pageOnAlert is off by default and sends nothing", () => {
	const mod = makeModule({ alertPage: 2 });
	send(mod, "BIRDFY_ALERT", ALERT);
	assert.deepEqual(mod.sent, []);
});

test("pageOnAlert sends PAGE_CHANGED with alertPage when enabled", () => {
	const mod = makeModule({ pageOnAlert: true, alertPage: 2 });
	send(mod, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now() });
	assert.deepEqual(mod.sent.map((n) => n.name), ["PAGE_CHANGED", "PAUSE_ROTATION"]);
	assert.equal(mod.sent[0].payload, 2);
});

test("pageOnAlert without a valid alertPage does not switch pages", () => {
	for (const alertPage of [null, undefined, -1, "2", 1.5]) {
		const mod = makeModule({ pageOnAlert: true, alertPage });
		send(mod, "BIRDFY_ALERT", ALERT);
		assert.deepEqual(mod.sent, [], `alertPage ${String(alertPage)} must not send`);
	}
});

// ── Token hygiene ──────────────────────────────────────────────────────────

/**
 * Collect every string a rendered tree exposes.
 * @param {FakeElement} root Element to walk.
 * @returns {string} All class names, text, URLs and styles joined.
 */
function dumpTree (root) {
	return [
		root.className,
		root.textContent,
		root.src,
		root.alt,
		root.poster,
		JSON.stringify(root.style),
		...root.children.map(dumpTree)
	].filter(Boolean).join("\n");
}

test("the HA token is never rendered or logged by the front end", () => {
	const token = "SECRET-LONG-LIVED-TOKEN-123";
	const logged = [];
	const originalLog = { info: Log.info, warn: Log.warn, error: Log.error };
	for (const level of ["info", "warn", "error"]) {
		Log[level] = (...args) => logged.push(args.join(" "));
	}
	try {
		const mod = makeModule({
			source: "homeassistant",
			haUrl: "https://ha.example.test:8123",
			haToken: token,
			pageOnAlert: true
		});
		const views = [];
		views.push(dumpTree(render(mod)));
		send(mod, "BIRDFY_STATUS", { source: "homeassistant", connected: false });
		send(mod, "BIRDFY_ERROR", { key: "homeassistant", message: "HA connection lost" });
		send(mod, "BIRDFY_TODAY", { visitors: [{ name: "A", count: 1 }], totalVisitsToday: 1 });
		views.push(dumpTree(render(mod)));
		send(mod, "BIRDFY_ALERT", ALERT);
		views.push(dumpTree(render(mod)));
		moduleDefinition.notificationReceived.call(mod, "BIRDFY_DEMO", {});
		views.push(dumpTree(render(mod)));

		for (const view of views) assert.ok(!view.includes(token), "token leaked into the DOM");
		for (const line of logged) assert.ok(!line.includes(token), `token leaked into a log line: ${line}`);
		assert.ok(!JSON.stringify(mod.sent).includes(token), "token leaked into a module notification");
	} finally {
		Object.assign(Log, originalLog);
	}
});

// ── Home Assistant errors, count wording, defaults ─────────────────────────

test("a terminal HA auth error shows its own message and never promises a reconnect", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_STATUS", {
		source: "homeassistant",
		connected: false,
		retrying: false,
		haError: { kind: "auth", message: "Home Assistant rejected the access token (check haToken)", since: 1, terminal: true }
	});
	const text = textOf(render(mod));
	assert.ok(text.includes("rejected the access token"), text);
	assert.ok(!text.includes("reconnecting"), text);
});

test("a terminal disconnect without a message does not say reconnecting; a retrying one does", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_STATUS", { source: "homeassistant", connected: false, retrying: false });
	assert.ok(!textOf(render(mod)).includes("reconnecting"));

	send(mod, "BIRDFY_STATUS", { source: "homeassistant", connected: false });
	assert.ok(textOf(render(mod)).includes("reconnecting"));
});

test("discovery and connection errors show their message; reconnect clears them", () => {
	const mod = makeModule();
	send(mod, "BIRDFY_STATUS", {
		source: "homeassistant",
		haError: { kind: "discovery", message: "No Birdfy sensors found in Home Assistant", since: 1, terminal: false }
	});
	assert.ok(textOf(render(mod)).includes("No Birdfy sensors found"));

	send(mod, "BIRDFY_STATUS", { source: "homeassistant", connected: true });
	assert.ok(!textOf(render(mod)).includes("No Birdfy sensors found"));
});

test("BIRDFY_ERROR for homeassistant keys is shown verbatim, not as an unreachable-since line", () => {
	const mod = makeModule();
	mod.loaded = true;
	send(mod, "BIRDFY_ERROR", { key: "homeassistant-feeders", message: "No Birdfy sensors found in Home Assistant" });
	const lines = findAll(render(mod), "birdfy-error").map((el) => el.textContent);
	assert.deepEqual(lines, ["No Birdfy sensors found in Home Assistant"]);
});

test("idle count note follows BIRDFY_TODAY.countSource and is omitted when no counts are shown", () => {
	const visitors = [{ name: "A", count: 1 }];
	const notes = {
		highlights: "Counts from Birdfy highlights",
		detections: "Counts from detections seen by this mirror",
		mixed: "Counts from Birdfy highlights and detections seen by this mirror"
	};
	for (const [countSource, expected] of Object.entries(notes)) {
		const mod = makeModule();
		send(mod, "BIRDFY_TODAY", { visitors, totalVisitsToday: 1, countSource });
		assert.equal(findAll(render(mod), "birdfy-note")[0].textContent, expected);
	}

	const bare = makeModule();
	send(bare, "BIRDFY_TODAY", { visitors: [{ name: "A" }] });
	assert.equal(findAll(render(bare), "birdfy-note").length, 0);
});

test("maxAlertAge defaults to null so node_helper can choose per mode", () => {
	assert.equal(moduleDefinition.defaults.maxAlertAge, null);
});

// ── pageOnAlert: jump, pause rotation, guaranteed resume ───────────────────

const NAMES = (mod) => mod.sent.map((n) => n.name);

/**
 * Run a body with mock timers and always restore the real ones.
 * @param {Function} body Test body.
 */
function withMockTimers (body) {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	try {
		body();
	} finally {
		mock.timers.reset();
	}
}

test("pageOnAlert jumps, then pauses rotation, then resumes once after displayDuration", () => {
	withMockTimers(() => {
		const mod = makeModule({ pageOnAlert: true, alertPage: 4, displayDuration: 60000 });
		send(mod, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now() });
		assert.deepEqual(mod.sent, [
			{ name: "PAGE_CHANGED", payload: 4 },
			{ name: "PAUSE_ROTATION", payload: undefined }
		]);
		mock.timers.tick(59000);
		assert.deepEqual(NAMES(mod), ["PAGE_CHANGED", "PAUSE_ROTATION"]);
		mock.timers.tick(1500);
		assert.deepEqual(NAMES(mod), ["PAGE_CHANGED", "PAUSE_ROTATION", "RESUME_ROTATION"]);
		mock.timers.tick(10 * 60 * 1000);
		assert.equal(mod.sent.filter((n) => n.name === "RESUME_ROTATION").length, 1);
	});
});

test("the resume timer is wall clock: it fires even if the module stays suspended", () => {
	withMockTimers(() => {
		const mod = makeModule({ pageOnAlert: true, alertPage: 4, displayDuration: 60000 });
		moduleDefinition.suspend.call(mod);
		send(mod, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now() });
		mock.timers.tick(61000);
		assert.deepEqual(NAMES(mod), ["PAGE_CHANGED", "PAUSE_ROTATION", "RESUME_ROTATION"]);
		assert.ok(mod.alert, "the alert itself still waits for first visibility");
	});
});

test("every jump re-pauses, with one release timer and a single RESUME", () => {
	withMockTimers(() => {
		const mod = makeModule({ pageOnAlert: true, alertPage: 4, displayDuration: 60000 });
		send(mod, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now() });
		mock.timers.tick(40000);
		send(mod, "BIRDFY_ALERT", { ...ALERT, id: "a2", timestamp: Date.now() });
		assert.deepEqual(NAMES(mod), ["PAGE_CHANGED", "PAUSE_ROTATION", "PAGE_CHANGED", "PAUSE_ROTATION"]);
		mock.timers.tick(30000);
		assert.ok(!NAMES(mod).includes("RESUME_ROTATION"), "old timer must not release early");
		mock.timers.tick(31000);
		assert.equal(NAMES(mod).filter((n) => n === "RESUME_ROTATION").length, 1);
	});
});

test("an alert while our page is already visible still counts as arrived once resume() runs", () => {
	withMockTimers(() => {
		const mod = makeModule({ pageOnAlert: true, alertPage: 4, displayDuration: 60000 });
		send(mod, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now() });
		// MagicMirror's show() runs resume() after PAGE_CHANGED even when already visible
		moduleDefinition.resume.call(mod);
		moduleDefinition.suspend.call(mod);
		assert.equal(NAMES(mod).filter((n) => n === "RESUME_ROTATION").length, 1);
	});
});

// A port of the rotation logic in MMM-pages (PAGE_CHANGED restarts a paused
// rotation timer; PAUSE/RESUME toggle it), wired to the real module, to prove
// the hold survives a second alert.
test("against an MMM-pages stub, a second alert during a hold gets the full displayDuration", () => {
	withMockTimers(() => {
		const pages = {
			rotationTime: 20000,
			count: 5,
			curPage: 0,
			running: false,
			timer: null,
			stopTimer () {
				if (this.timer) {
					clearInterval(this.timer);
					this.timer = null;
				}
			},
			restart () {
				this.stopTimer();
				this.running = true;
				this.timer = setInterval(() => this.notify("PAGE_INCREMENT"), this.rotationTime);
			},
			notify (name, payload) {
				if (name === "PAGE_CHANGED") {
					this.curPage = payload;
					this.show();
					if (!this.running) this.restart();
				} else if (name === "PAGE_INCREMENT") {
					this.curPage = (this.curPage + 1) % this.count;
					this.show();
				} else if (name === "PAUSE_ROTATION") {
					this.stopTimer();
					this.running = false;
				} else if (name === "RESUME_ROTATION" && !this.running) {
					this.restart();
				}
			},
			show () {
				if (this.curPage === 4) {
					setTimeout(() => {
						if (this.curPage === 4) moduleDefinition.resume.call(mod);
					}, 500);
				} else {
					moduleDefinition.suspend.call(mod);
				}
			}
		};
		const mod = makeModule({ pageOnAlert: true, alertPage: 4, displayDuration: 60000 });
		mod.sendNotification = (name, payload) => pages.notify(name, payload);
		pages.restart();

		mock.timers.tick(25000);
		send(mod, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now() });
		mock.timers.tick(21000);
		assert.equal(pages.curPage, 4, "held on page 4");

		send(mod, "BIRDFY_ALERT", { ...ALERT, id: "a2", timestamp: Date.now() });
		mock.timers.tick(59000);
		assert.equal(pages.curPage, 4, "second alert keeps its full 60 s");
		assert.equal(pages.running, false);

		mock.timers.tick(2000);
		assert.equal(pages.running, true, "rotation resumed after displayDuration");
		mock.timers.tick(25000);
		assert.notEqual(pages.curPage, 4, "and moves on");
	});
});

test("no RESUME_ROTATION is sent when we never paused", () => {
	withMockTimers(() => {
		for (const config of [{}, { pageOnAlert: true }, { pageOnAlert: true, alertPage: -1 }]) {
			const mod = makeModule({ displayDuration: 1000, ...config });
			send(mod, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now() });
			mock.timers.tick(5000);
			moduleDefinition.suspend.call(mod);
			assert.deepEqual(mod.sent, [], JSON.stringify(config));
		}
	});
});

test("alerts older than maxAlertAge and priming replays do not jump", () => {
	withMockTimers(() => {
		const stale = makeModule({ pageOnAlert: true, alertPage: 4, maxAlertAge: 60000 });
		send(stale, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now() - 120000 });
		assert.deepEqual(stale.sent, []);
		assert.ok(stale.alert, "a stale alert is still displayed");

		const ha = makeModule({ pageOnAlert: true, alertPage: 4, source: "homeassistant" });
		send(ha, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now() - 45 * 60 * 1000 });
		assert.deepEqual(NAMES(ha), ["PAGE_CHANGED", "PAUSE_ROTATION"], "HA default window is 60 minutes");

		const cloud = makeModule({ pageOnAlert: true, alertPage: 4 });
		send(cloud, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now() - 45 * 60 * 1000 });
		assert.deepEqual(cloud.sent, [], "cloud default window is 30 minutes");

		const primed = makeModule({ pageOnAlert: true, alertPage: 4 });
		send(primed, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now(), priming: true });
		assert.deepEqual(primed.sent, []);
	});
});

test("leaving our page after arriving releases rotation immediately, once", () => {
	withMockTimers(() => {
		const mod = makeModule({ pageOnAlert: true, alertPage: 4, displayDuration: 60000 });
		moduleDefinition.suspend.call(mod);
		send(mod, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now() });

		moduleDefinition.suspend.call(mod);
		assert.ok(!NAMES(mod).includes("RESUME_ROTATION"), "not arrived yet: keep the pause");

		moduleDefinition.resume.call(mod);
		mock.timers.tick(5000);
		moduleDefinition.suspend.call(mod);
		assert.equal(NAMES(mod).filter((n) => n === "RESUME_ROTATION").length, 1);

		mock.timers.tick(120000);
		assert.equal(NAMES(mod).filter((n) => n === "RESUME_ROTATION").length, 1, "timer must be cancelled");
	});
});

test("dismissing the alert and stop() never leave rotation paused", () => {
	withMockTimers(() => {
		const mod = makeModule({ pageOnAlert: true, alertPage: 4, displayDuration: 60000 });
		send(mod, "BIRDFY_ALERT", { ...ALERT, timestamp: Date.now() });
		moduleDefinition.stop.call(mod);
		assert.deepEqual(NAMES(mod), ["PAGE_CHANGED", "PAUSE_ROTATION", "RESUME_ROTATION"]);
		moduleDefinition.stop.call(mod);
		assert.equal(NAMES(mod).filter((n) => n === "RESUME_ROTATION").length, 1);
	});
});
