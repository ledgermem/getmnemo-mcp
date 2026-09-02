# Changelog

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
