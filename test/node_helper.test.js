"use strict";

// MagicMirror core aliases "node_helper" / "logger" at runtime; stub them so
// this file can `require("../node_helper.js")` in isolation.
require("./support/mm-stubs");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const Log = require("logger");
const NodeHelperClass = require("../node_helper");

const { normaliseAlert, safeUrl, resolveTimestamp, isWebhookAuthorized } = NodeHelperClass.prototype._testables;

/**
 * Build a fresh node_helper instance with sendSocketNotification stubbed to
 * record every notification instead of touching socket.io.
 * @returns {{helper: object, sent: Array<{notification: string, payload: object}>}} The helper and its sent log.
 */
function makeHelper () {
	const helper = new NodeHelperClass();
	helper.name = "MMM-Birdfy";
	const sent = [];
	helper.sendSocketNotification = (notification, payload) => {
		sent.push({ notification, payload });
	};
	helper.start();
	return { helper, sent };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

test("safeUrl only allows http(s) URLs", () => {
	assert.equal(safeUrl("https://example.com/a.jpg"), "https://example.com/a.jpg");
	assert.equal(safeUrl("http://example.com/a.jpg"), "http://example.com/a.jpg");
	assert.equal(safeUrl("javascript:alert(1)"), null);
	assert.equal(safeUrl("rtmp://example.com/live"), null);
	assert.equal(safeUrl(""), null);
	assert.equal(safeUrl(undefined), null);
	assert.equal(safeUrl(null), null);
});

test("resolveTimestamp converts unix seconds to ms", () => {
	const seconds = Math.floor(Date.now() / 1000);
	assert.equal(resolveTimestamp(seconds, undefined), seconds * 1000);
});

test("resolveTimestamp keeps unix ms as-is", () => {
	const ms = Date.now();
	assert.equal(resolveTimestamp(ms, undefined), ms);
});

test("resolveTimestamp falls back to created_at date string", () => {
	const iso = "2024-05-01T12:00:00.000Z";
	assert.equal(resolveTimestamp(undefined, iso), Date.parse(iso));
});

test("resolveTimestamp falls back to now for garbage input", () => {
	const before = Date.now();
	const result = resolveTimestamp("not-a-date", "also-not-a-date");
	const after = Date.now();
	assert.ok(result >= before && result <= after);
});

test("normaliseAlert drops unsafe media URLs", () => {
	const alert = normaliseAlert({
		species: "House Sparrow",
		imageUrl: "javascript:alert(1)",
		videoUrl: "https://example.com/clip.mp4",
		streamUrl: "rtmp://example.com/live"
	}, "Feeder");
	assert.equal(alert.imageUrl, null);
	assert.equal(alert.videoUrl, "https://example.com/clip.mp4");
	assert.equal(alert.streamUrl, null);
});

test("isWebhookAuthorized allows everything when no token configured", () => {
	assert.equal(isWebhookAuthorized({ get: () => undefined, query: {} }, ""), true);
});

test("isWebhookAuthorized accepts a matching bearer header", () => {
	const req = { get: (h) => (h === "Authorization" ? "Bearer secret" : undefined), query: {} };
	assert.equal(isWebhookAuthorized(req, "secret"), true);
});

test("isWebhookAuthorized accepts a matching query token", () => {
	const req = { get: () => undefined, query: { token: "secret" } };
	assert.equal(isWebhookAuthorized(req, "secret"), true);
});

test("isWebhookAuthorized rejects missing or wrong credentials", () => {
	const req = { get: () => undefined, query: {} };
	assert.equal(isWebhookAuthorized(req, "secret"), false);
	const wrong = { get: (h) => (h === "Authorization" ? "Bearer nope" : undefined), query: {} };
	assert.equal(isWebhookAuthorized(wrong, "secret"), false);
});

// ── Config validation / error state ─────────────────────────────────────────

test("empty config (no sources, webhook disabled) reports a configError and still sends READY", () => {
	const { helper, sent } = makeHelper();
	helper.socketNotificationReceived("BIRDFY_CONFIG", { sources: [], webhookEnabled: false });

	const status = sent.find((n) => n.notification === "BIRDFY_STATUS");
	assert.ok(status, "expected a BIRDFY_STATUS notification");
	assert.ok(status.payload.configError, "expected a non-empty configError message");
	assert.match(status.payload.configError, /no birdfy sources configured/i);

	const ready = sent.find((n) => n.notification === "BIRDFY_READY");
	assert.ok(ready, "expected BIRDFY_READY so the frontend does not stay in a loading state forever");
});

test("deprecated apiEmail/apiPassword/deviceIds keys are flagged without leaking the password", () => {
	const { helper, sent } = makeHelper();
	const originalWarn = Log.warn;
	const warnings = [];
	Log.warn = (...args) => warnings.push(args.join(" "));
	try {
		helper.socketNotificationReceived("BIRDFY_CONFIG", {
			sources: [],
			webhookEnabled: false,
			apiEmail: "user@example.com",
			apiPassword: "hunter2-plaintext-secret",
			deviceIds: ["abc123"]
		});
	} finally {
		Log.warn = originalWarn;
	}

	const status = sent.find((n) => n.notification === "BIRDFY_STATUS");
	assert.match(status.payload.configError, /apiEmail|apiPassword|deviceIds/);

	const warningText = warnings.join(" ");
	assert.match(warningText, /apiEmail/);
	assert.doesNotMatch(warningText, /hunter2-plaintext-secret/);
});

test("valid sources config clears configError", () => {
	const { helper, sent } = makeHelper();
	// Prevent the real Birdfy API from being hit during this test.
	helper._pollAll = async () => {};
	helper.socketNotificationReceived("BIRDFY_CONFIG", {
		sources: [{ name: "Feeder", uuid: "test-uuid" }],
		webhookEnabled: false,
		pollInterval: 60000,
		maxAlertAge: 1800000
	});
	clearInterval(helper.pollTimer);

	const status = sent.find((n) => n.notification === "BIRDFY_STATUS");
	assert.ok(status);
	assert.equal(status.payload.configError, null);
});

// ── Webhook server ──────────────────────────────────────────────────────────

test("webhook binds to 127.0.0.1 by default", async () => {
	const { helper } = makeHelper();
	helper.config = { webhookPath: "/birdfy", webhookPort: 0 };
	helper._startWebhookServer();
	await once(helper.webhookServer, "listening");
	try {
		assert.equal(helper.webhookServer.address().address, "127.0.0.1");
	} finally {
		helper.webhookServer.close();
	}
});

test("webhook rejects requests without the configured shared secret", async () => {
	const { helper, sent } = makeHelper();
	helper.config = { webhookPath: "/birdfy", webhookPort: 0, webhookToken: "s3cret" };
	helper._startWebhookServer();
	await once(helper.webhookServer, "listening");
	const port = helper.webhookServer.address().port;

	try {
		const noAuth = await fetch(`http://127.0.0.1:${port}/birdfy`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ species: "House Sparrow" })
		});
		assert.equal(noAuth.status, 401);

		const authed = await fetch(`http://127.0.0.1:${port}/birdfy`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
			body: JSON.stringify({ species: "House Sparrow" })
		});
		assert.equal(authed.status, 200);

		const alertNotifications = sent.filter((n) => n.notification === "BIRDFY_ALERT");
		assert.equal(alertNotifications.length, 1);
		assert.equal(alertNotifications[0].payload.species, "House Sparrow");

		const queryAuthed = await fetch(`http://127.0.0.1:${port}/birdfy?token=s3cret`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ species: "Blue Jay" })
		});
		assert.equal(queryAuthed.status, 200);
	} finally {
		helper.webhookServer.close();
	}
});

test("webhook does not log the raw request body", async () => {
	const { helper } = makeHelper();
	helper.config = { webhookPath: "/birdfy", webhookPort: 0 };
	helper._startWebhookServer();
	await once(helper.webhookServer, "listening");
	const port = helper.webhookServer.address().port;

	const originalLog = Log.log;
	const logged = [];
	Log.log = (...args) => logged.push(args.join(" "));

	try {
		await fetch(`http://127.0.0.1:${port}/birdfy`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ species: "House Sparrow", imageUrl: "https://example.com/SECRET-SIGNED-TOKEN.jpg" })
		});
	} finally {
		Log.log = originalLog;
		helper.webhookServer.close();
	}

	const allLogged = logged.join(" ");
	assert.doesNotMatch(allLogged, /SECRET-SIGNED-TOKEN/);
	assert.match(allLogged, /bytes/);
});

test("a webhook bind failure (EADDRINUSE) is surfaced as BIRDFY_ERROR, not an uncaught exception", async () => {
	const first = makeHelper();
	first.helper.config = { webhookPath: "/birdfy", webhookPort: 0 };
	first.helper._startWebhookServer();
	await once(first.helper.webhookServer, "listening");
	const port = first.helper.webhookServer.address().port;

	// try/finally: an assertion failure below must not leak `first`'s open
	// server — that would hold the process open and hang the whole suite.
	try {
		const second = makeHelper();
		second.helper.config = { webhookPath: "/birdfy", webhookPort: port };
		second.helper._startWebhookServer();
		const failedServer = second.helper.webhookServer;
		await once(failedServer, "error");

		const error = second.sent.find((n) => n.notification === "BIRDFY_ERROR");
		assert.ok(error, "expected a BIRDFY_ERROR notification");
		// A specific, actionable message ("Webhook port 8765 in use"), not the
		// generic "Birdfy unreachable" wording used for source polling errors.
		assert.match(error.payload.message, new RegExp(`webhook port ${port} in use`, "i"));
		assert.equal(error.payload.key, "webhook");
		assert.equal(second.helper.webhookServer, null);
	} finally {
		first.helper.webhookServer.close();
	}
});

// ── Item 1: errors are keyed by origin (source uuid, or "webhook") ─────────

test("one source's successful poll does not clear another source's error", async () => {
	const { helper, sent } = makeHelper();
	helper.config = { maxAlertAge: 1800000, pollInterval: 60000 };

	const failing = {
		api: { name: "Backyard", uuid: "uuid-fail", getToday: async () => { throw new Error("network down"); } },
		seen: new Set(), errorCount: 0, lastErrorLog: 0, lastValidityCheck: 0, invalid: false,
		speciesDay: null, speciesSeen: new Set(), speciesPrimed: false, visitors: []
	};
	const healthy = {
		api: { name: "Porch", uuid: "uuid-ok", getToday: async () => ({ birdList: [], dataList: [] }), getRecentDayCount: async () => 1 },
		seen: new Set(), errorCount: 0, lastErrorLog: 0, lastValidityCheck: Date.now(), invalid: false,
		speciesDay: null, speciesSeen: new Set(), speciesPrimed: false, visitors: []
	};
	helper.sources = [failing, healthy];

	await helper._pollAll();

	const error = sent.find((n) => n.notification === "BIRDFY_ERROR");
	assert.ok(error, "expected the failing source to report an error");
	assert.equal(error.payload.key, "uuid-fail");

	const cleared = sent
		.filter((n) => n.notification === "BIRDFY_STATUS" && n.payload.lastErrorCleared)
		.map((n) => n.payload.lastErrorCleared);
	assert.deepEqual(cleared, ["uuid-ok"], "only the healthy source's key should be reported as cleared");
	assert.ok(!cleared.includes("uuid-fail"), "the failing source's error must not be cleared by the other source's success");
});

test("a webhook bind failure is never cleared by a source poll succeeding", async () => {
	const { helper, sent } = makeHelper();
	helper.config = { webhookPath: "/birdfy", webhookPort: 0 };
	helper._startWebhookServer();
	await once(helper.webhookServer, "listening");
	const port = helper.webhookServer.address().port;
	helper.webhookServer.close();

	// Simulate the bind failure directly (avoids a real second EADDRINUSE race).
	helper._sendError(`Webhook port ${port} in use`, "webhook");

	helper.config = { maxAlertAge: 1800000, pollInterval: 60000 };
	const healthy = {
		api: { name: "Porch", uuid: "uuid-ok", getToday: async () => ({ birdList: [], dataList: [] }), getRecentDayCount: async () => 1 },
		seen: new Set(), errorCount: 0, lastErrorLog: 0, lastValidityCheck: Date.now(), invalid: false,
		speciesDay: null, speciesSeen: new Set(), speciesPrimed: false, visitors: []
	};
	helper.sources = [healthy];
	await helper._pollAll();

	const cleared = sent
		.filter((n) => n.notification === "BIRDFY_STATUS" && n.payload.lastErrorCleared)
		.map((n) => n.payload.lastErrorCleared);
	assert.ok(!cleared.includes("webhook"), "polling must never clear the webhook's own error key");
});

// ── Item 2: webhook auth runs before JSON parsing; JSON errors are safe ────

test("malformed JSON without a valid token is rejected (401) before the body is parsed", async () => {
	const { helper } = makeHelper();
	helper.config = { webhookPath: "/birdfy", webhookPort: 0, webhookToken: "s3cret" };
	helper._startWebhookServer();
	await once(helper.webhookServer, "listening");
	const port = helper.webhookServer.address().port;

	try {
		const res = await fetch(`http://127.0.0.1:${port}/birdfy`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{bad"
		});
		assert.equal(res.status, 401);
	} finally {
		helper.webhookServer.close();
	}
});

test("malformed JSON from an authorized caller gets a clean 400, not a stack trace, and is logged via Log", async () => {
	const { helper } = makeHelper();
	helper.config = { webhookPath: "/birdfy", webhookPort: 0 };
	helper._startWebhookServer();
	await once(helper.webhookServer, "listening");
	const port = helper.webhookServer.address().port;

	const originalErrorLog = Log.error;
	const errorLogs = [];
	Log.error = (...args) => errorLogs.push(args.join(" "));

	try {
		const res = await fetch(`http://127.0.0.1:${port}/birdfy`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{bad"
		});
		assert.equal(res.status, 400);
		const text = await res.text();
		assert.doesNotMatch(text, /\bat \S+ \(/, "response body must not contain a stack trace");
		assert.doesNotMatch(text, /[A-Za-z]:\\|\/home\/|\/Users\//, "response body must not leak filesystem paths");
		assert.ok(errorLogs.length > 0, "the parse failure should be logged via Log, not just stderr");
	} finally {
		Log.error = originalErrorLog;
		helper.webhookServer.close();
	}
});

// ── Item 5: deprecated-key warning fires whenever keys are present and there ──
// ── are no sources, even with the webhook enabled ──────────────────────────

test("deprecated-key configWarning appears even when the webhook is enabled", () => {
	const { helper, sent } = makeHelper();
	// Stand in for an already-running webhook server without opening a real
	// socket: socketNotificationReceived only checks truthiness before
	// deciding whether to start one.
	helper.webhookServer = {};

	helper.socketNotificationReceived("BIRDFY_CONFIG", {
		sources: [],
		webhookEnabled: true,
		webhookPort: 0,
		apiEmail: "user@example.com",
		apiPassword: "hunter2-plaintext-secret",
		deviceIds: ["abc123"]
	});

	const status = sent.find((n) => n.notification === "BIRDFY_STATUS" && "configWarning" in n.payload);
	assert.ok(status, "expected a BIRDFY_STATUS with a configWarning even though the webhook is enabled");
	assert.match(status.payload.configWarning, /apiEmail|apiPassword|deviceIds/);
	assert.doesNotMatch(status.payload.configWarning, /hunter2-plaintext-secret/);
});

// ── Polling path: priming, maxAlertAge, and reload de-duplication ──────────

test("_pollAll only announces a species once it has been primed by a prior poll", async () => {
	const { helper, sent } = makeHelper();
	helper.config = { maxAlertAge: 1800000, pollInterval: 60000 };
	const responses = [
		{ birdList: [{ name: "House Sparrow", coverKey: "https://example.com/sparrow.jpg" }], dataList: [] },
		{ birdList: [
			{ name: "House Sparrow", coverKey: "https://example.com/sparrow.jpg" },
			{ name: "Blue Jay", coverKey: "https://example.com/jay.jpg" }
		], dataList: [] }
	];
	let call = 0;
	const src = {
		api: { name: "Feeder", uuid: "species-uuid", getToday: async () => responses[call] },
		seen: new Set(), errorCount: 0, lastErrorLog: 0, lastValidityCheck: 0, invalid: false,
		speciesDay: null, speciesSeen: new Set(), speciesPrimed: false, visitors: []
	};
	helper.sources = [src];

	await helper._pollAll();
	assert.equal(sent.filter((n) => n.notification === "BIRDFY_ALERT").length, 0, "the first poll should only prime, not alert");

	call = 1;
	sent.length = 0;
	await helper._pollAll();
	const alerts = sent.filter((n) => n.notification === "BIRDFY_ALERT");
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].payload.species, "Blue Jay");
});

test("_pollAll ignores dataList alerts older than maxAlertAge", async () => {
	const { helper, sent } = makeHelper();
	helper.config = { maxAlertAge: 60000 };
	const oldTime = Date.now() - 3600000;
	const freshTime = Date.now() - 1000;
	const src = {
		api: {
			name: "Feeder",
			uuid: "age-uuid",
			getToday: async () => ({
				birdList: [],
				dataList: [
					{ detectObject: "Robin", createTime: oldTime, fileUrl: "https://example.com/old.mp4", category: "normal" },
					{ detectObject: "Cardinal", createTime: freshTime, fileUrl: "https://example.com/new.mp4", category: "normal" }
				]
			})
		},
		seen: new Set(), errorCount: 0, lastErrorLog: 0, lastValidityCheck: 0, invalid: false,
		speciesDay: null, speciesSeen: new Set(), speciesPrimed: false, visitors: []
	};
	helper.sources = [src];

	await helper._pollAll();
	const alerts = sent.filter((n) => n.notification === "BIRDFY_ALERT");
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].payload.species, "Cardinal");
});

test("re-sending BIRDFY_CONFIG (e.g. a browser reload) does not re-announce an already-seen clip", async () => {
	const { helper, sent } = makeHelper();
	helper.config = { maxAlertAge: 1800000, pollInterval: 60000 };

	const originalFetch = global.fetch;
	const clipTime = Date.now() - 1000;
	global.fetch = async () => ({
		ok: true,
		status: 200,
		json: async () => ({
			birdList: [],
			dataList: [{ detectObject: "Robin", createTime: clipTime, fileUrl: "https://example.com/clip.mp4", category: "normal" }]
		})
	});

	try {
		await helper._startPolling([{ name: "Feeder", uuid: "reload-uuid" }]);
		clearInterval(helper.pollTimer);
		assert.equal(sent.filter((n) => n.notification === "BIRDFY_ALERT").length, 1);

		sent.length = 0;
		await helper._startPolling([{ name: "Feeder", uuid: "reload-uuid" }]);
		clearInterval(helper.pollTimer);
		assert.equal(sent.filter((n) => n.notification === "BIRDFY_ALERT").length, 0);
	} finally {
		global.fetch = originalFetch;
	}
});
