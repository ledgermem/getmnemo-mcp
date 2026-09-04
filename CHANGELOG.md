# Changelog

## 0.3.1 — 2026-09-04

Fixes found while integrating Mnemo into a real third-party project (AI-SHIPR).

### Fixed
- **`GETMNEMO_WORKSPACE_ID` is no longer required.** The API derives the tenant
  from the API key, and `x-workspace-id` was retired in SDK 0.5.1. The server now
  starts without it and only sends the header when a workspace is explicitly
  configured. Requiring it forced every integrator to hunt for an id the platform
  no longer needs.
- **The startup error names the variable that is actually missing.** It used to
  say "missing GETMNEMO_API_KEY and/or GETMNEMO_WORKSPACE_ID", which sends you to
  debug the wrong one.

### Added
- **`whoAmI()`** on the API client, backed by the new `GET /v1/whoami`. Resolves
  the workspace, key id/label and granted scopes from the key itself, so a
  workspace id never has to be configured by hand. Requires no scope.

### Notes
- `memory_timeline` previously failed with `403 Key missing required scope(s):
  timeline:read` for most keys. The root cause was in the API's default scope set
  (a standard key was missing read scopes a read-only key had) and is fixed
  there; it takes effect for keys minted after that API deploy.

All notable changes to `getmnemo-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-09-02

### Added
- Personal-memory tools against Mnemo API v0.3.0: `daily_brief`, `memory_timeline`,
  `people_list`, `people_get`, `people_upsert`, `reminder_create`, `reminders_upcoming`,
  `reminder_complete`, `meetings_upcoming`, `meeting_brief`, `memory_merge`.
- Every new tool description names the API-key scope(s) it needs and the
  `MEMORY_API_*` deployment flag; `503 FEATURE_DISABLED` and `403` (missing scope /
  hosted-OAuth token) map to tool errors that say exactly that. Stable API error
  codes (`PERSON_NOT_FOUND`, `NOT_A_REMINDER`, `MERGE_PROTECTED`, ...) are surfaced
  verbatim; `MnemoApiError.code` exposes them programmatically.
- `people_upsert` composes `POST /v1/people` + `PATCH /v1/people/{slug}` (create, then
  update on `409 PERSON_EXISTS`; with an explicit `slug`, update then create on 404).
- `createServer(cfg, { principal })`: hosted OAuth sessions no longer list the
  API-key-only tools (the API denies MCP tokens on cross-container routes);
  `memory_timeline` stays available to them.
- `MnemoApiClient` methods for the new surface; `personal-types.ts` wire types
  re-exported from the package root.
- ESLint flat config (`typescript-eslint`, mirrors `getmnemo-js`) so `npm run lint` runs.

### Changed
- Server version advertised in the MCP handshake is now `0.3.0` (`SERVER_VERSION`,
  pinned to `package.json` by a test).

## [0.2.0]

- Per-call container targeting via `X-Mnemo-Container`; all/multi-container hosted
  OAuth grants; full scope set advertised in the `WWW-Authenticate` challenge.
