"use strict";

// Stand-ins for MagicMirror core's "node_helper" and "logger" modules, which
// MagicMirror registers as aliases at runtime (js/node_helper.js, js/logger.js).
// This repo is tested standalone, so they are stubbed here instead of pulling
// MagicMirror (or module-alias) in as a dependency.

const Module = require("node:module");

const Log = {
	log () {},
	info () {},
	warn () {},
	error () {},
	debug () {}
};

const NodeHelper = {
	create (definition) {
		class Helper {
			setName (name) {
				this.name = name;
			}

			sendSocketNotification () {}
		}
		Object.assign(Helper.prototype, definition);
		return Helper;
	}
};

const originalLoad = Module._load;
Module._load = function load (request, ...rest) {
	if (request === "node_helper") return NodeHelper;
	if (request === "logger") return Log;
	return originalLoad.call(this, request, ...rest);
};

module.exports = { Log, NodeHelper };
