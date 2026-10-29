# Live check against Immich

Run on 26 Oct 2026 (Africa/Accra) against a real, self-built Immich server `v3.3.0-rc.0`
(the same release as the bundled OpenAPI spec), on the box, with no sign-up and no Docker:

- Immich server built from the public source (`immich-app/immich`, main) and run with Node 24.
- PostgreSQL 18 with the `vector` (pgvector 0.8.7) and `vchord` (VectorChord 1.1.1) extensions.
- Valkey 8.1 (Redis-compatible). No machine-learning container, no web UI build.
- Reverse-geocoding data was a one-city stub so the server could boot (no geonames download).
- A local admin was created on that throw-away instance and a local API key was used. No real photos.

Command: `IMMICH_URL=... IMMICH_API_KEY=... npm run live-check` (spawns `dist/index.js` over stdio with `IMMICH_TOOLSETS=all`, `IMMICH_ALLOW_WRITES=true`).

Result: **failed=0**, 22 tools listed, 28 checks passed.

Exercised for real (reads and confirmed writes, with previews checked first):
server version and about info, albums (list, create, update, delete), people list, search,
tags (create, delete), asset upload from a local file (multipart), asset info (server paths stripped),
asset update, original download to `save_path`, asset statistics, memory create and delete,
shared-link create and remove, API key create (secret redacted) and delete, system config read,
current user, hard delete of the uploaded asset.

NOT exercised live (covered only by mock-server unit tests): the other ~250 of the 287 operations,
including library scans, user admin, session revoke, sidecar upload, trash empty, jobs, workflows,
plugins, partners, notifications, sync streams, smart search (needs the ML service),
and the 429 path (mock-tested only).

Error paths seen live: a bad API key, an unknown album and an empty create-album body all came back as clean `isError` results (real Immich answers 400 for the last two, not 404/422; the 401/404/422/429 mapping is mock-tested).
