# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `package.json`: repository, homepage, bugs, license and keywords fields.
- README: Update section and trailing commas in the config examples.
- Node built-ins are imported with the `node:` scheme (for example `node:https`).
- ESLint (flat config) with an `npm run lint` script.
- Added CHANGELOG, CODE_OF_CONDUCT and a Dependabot configuration.

### Changed

- ESLint 10, with `defineConfig` in `eslint.config.mjs`; `npm run lint` runs `eslint` without the trailing `.`.
- README: real clone URL and no `modules: [` snippet.
- Birdfy request errors keep the underlying error as `cause`.
- Updated `express` to 5.2.
- `package.json`: lowercase package name, `"type": "commonjs"` and an author.
- The webhook error handler passes errors on to Express when a response has already started, and has tests for malformed and oversized JSON.
- ESLint reports unused catch bindings and arguments, and lints `package.json`, as modules.magicmirror.builders does.

## [1.0.0]

Released before this changelog was started. Commit history, newest first:

### 2026-10-03

- README: current screenshot and documentation review

### 2026-10-01

- Read all feeders from Home Assistant and show a larger alert card

### 2026-09-29

- Show API and config errors, secure the webhook, day-mode styling, Express 5

### 2026-09-25

- Render Birdfy as a glass card with its own title
- Show today's visitors between alerts instead of "No recent visitors"

### 2026-09-24

- Announce identified species sightings from birdList
- Detect expired Birdfy share UUIDs and show it on the mirror
- Poll Birdfy highlights by share UUID; replace non-working login API

### 2026-04-25

- Only trigger alert when Birdfy has identified a bird species
- Initial commit: MMM-Birdfy MagicMirror module
