"use strict";

// MMM-Birdfy.js is written against MagicMirror's browser globals
// (Module.register, Log, document). This file stubs the minimum needed to
// load the module definition and exercise its plain-JS logic (error
// bookkeeping, getDom's element tree) without a real browser or the
// MagicMirror core bundle.

const { test } = require("node:test");
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
	}

	appendChild (child) {
		this.children.push(child);
		return child;
	}

	remove () {}
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
	mod.domUpdates = 0;
	mod.updateDom = () => {
		mod.domUpdates += 1;
	};
	moduleDefinition.start.call(mod);
	return mod;
}

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
