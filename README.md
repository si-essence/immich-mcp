# immich-mcp (Immich MCP connector)

MCP connector for a self-hosted [Immich](https://github.com/immich-app/immich) instance. It speaks the Immich REST API over stdio and over stateless Streamable HTTP on localhost.

Immich is AGPL-3.0 software. This connector is MIT. It only calls the public REST API on the server you configure. It is not affiliated with Immich or the Immich maintainers. Bring your own API key from the Immich user settings.

The connector covers all 199 paths and 287 operations in `immich.openapi.json` (Immich 3.3.0-rc.0). Operations are grouped into 22 toolsets. Enable a subset with `IMMICH_TOOLSETS` so the model only sees the tools you need.

## Setup

```bash
npm install
npm run ci
npm start
npm run start:http
```

`npm start` speaks stdio. `npm run start:http` serves Streamable HTTP at `http://127.0.0.1:3000/mcp` and `GET /health`. HTTP mode has no authentication. Keep it on localhost.

Create an API key in Immich (Account settings, API Keys). The connector sends it as `x-api-key` and never prints it.

```json
{
  "mcpServers": {
    "immich": {
      "command": "node",
      "args": ["/workspace/connectors/immich/dist/index.js"],
      "env": {
        "IMMICH_URL": "https://photos.example.com",
        "IMMICH_API_KEY": "...",
        "IMMICH_ALLOW_WRITES": "false",
        "IMMICH_TOOLSETS": "assets,albums,people,search,server",
        "IMMICH_CONTACT": "you@example.com"
      }
    }
  }
}
```

A trailing `/api` on `IMMICH_URL` is stripped. The API is called at `{IMMICH_URL}/api`.

Docker (HTTP, no authentication, localhost only):

```bash
docker build -t immich-mcp .
docker run -p 3000:3000 \
  -e IMMICH_URL=http://host.docker.internal:2283 \
  -e IMMICH_API_KEY=... \
  immich-mcp
```

Do not put the API key in the image.

Regenerate the operations registry after an OpenAPI bump:

```bash
npm run gen:operations
```

## Config

| Variable               | Meaning                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `IMMICH_URL`           | Server base, for example `https://photos.example.com`. `/api` is appended.                         |
| `IMMICH_API_KEY`       | API key. Sent as `x-api-key`.                                                                      |
| `IMMICH_ALLOW_WRITES`  | Must be the literal `true` before a confirmed write is sent.                                       |
| `IMMICH_TOOLSETS`      | Comma list of toolsets, or `all`. Default `assets,albums,people,search,server`. `admin` is opt-in. |
| `IMMICH_PER_MINUTE`    | Local request budget. Default 30.                                                                  |
| `IMMICH_TIMEOUT_MS`    | Upstream timeout. Default 20000.                                                                   |
| `IMMICH_CACHE_TTL_SEC` | GET cache TTL. Default 60. Writes clear the cache.                                                 |
| `IMMICH_CONTACT`       | Contact token in the User-Agent.                                                                   |
| `MCP_TRANSPORT`        | `stdio` or `http`. `--http` overrides.                                                             |
| `PORT`                 | HTTP port. Default 3000.                                                                           |

## Safety

Every non-GET operation is gated unless the registry marks it read-only. Search metadata, smart search, random search, bulk-upload check, download info, and a few other POST reads are read-only. They run without `confirm`.

A write needs `confirm: true` and `IMMICH_ALLOW_WRITES=true`. Otherwise the tool returns a dry-run preview of the exact method, path, query, and body. The API key is redacted. Deletes, empty trash, user deletion, library scan or removal, API-key and session revoke, shared-link creation, and admin config changes add extra warnings in that preview.

Asset upload is multipart from a local `file_path` and is confirm-gated. Original and thumbnail downloads return metadata only, or write bytes to `save_path`. Binaries are not dumped into the model context. Server filesystem paths, tokens, passwords, and shared-link keys are stripped or redacted.

## Tools

Default `IMMICH_TOOLSETS` publishes 5 tools (107 operations). `IMMICH_TOOLSETS=all` publishes 22 tools (287 operations). Each tool takes `action` plus `params`, `query`, `body`, and optional `file_path`, `save_path`, and `confirm`.

| Toolset        | Tool                    | Operations | Tags                                                                                                                                                        | Default |
| -------------- | ----------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| assets         | `immich_assets`         | 43         | Assets, Asset files, Download, Duplicates, Stacks                                                                                                           | yes     |
| albums         | `immich_albums`         | 13         | Albums                                                                                                                                                      | yes     |
| people         | `immich_people`         | 19         | People, Faces                                                                                                                                               | yes     |
| search         | `immich_search`         | 16         | Search, Map, Timeline, Views                                                                                                                                | yes     |
| server         | `immich_server`         | 16         | Server, Config (public)                                                                                                                                     | yes     |
| admin          | `immich_admin`          | 40         | Users (admin), Maintenance (admin), Config (admin), Database Backups (admin), Notifications (admin), Authentication (admin), System config, System metadata | no      |
| users          | `immich_users`          | 18         | Users, Config (user)                                                                                                                                        | no      |
| sessions       | `immich_sessions`       | 31         | Sessions, Authentication, Passkeys                                                                                                                          | no      |
| libraries      | `immich_libraries`      | 8          | Libraries                                                                                                                                                   | no      |
| tags           | `immich_tags`           | 9          | Tags                                                                                                                                                        | no      |
| trash          | `immich_trash`          | 3          | Trash                                                                                                                                                       | no      |
| memories       | `immich_memories`       | 8          | Memories                                                                                                                                                    | no      |
| jobs           | `immich_jobs`           | 8          | Jobs, Queues                                                                                                                                                | no      |
| shared-links   | `immich_shared_links`   | 9          | Shared links                                                                                                                                                | no      |
| api-keys       | `immich_api_keys`       | 7          | API keys                                                                                                                                                    | no      |
| partners       | `immich_partners`       | 5          | Partners                                                                                                                                                    | no      |
| activities     | `immich_activities`     | 4          | Activities                                                                                                                                                  | no      |
| notifications  | `immich_notifications`  | 6          | Notifications                                                                                                                                               | no      |
| sync           | `immich_sync`           | 4          | Sync                                                                                                                                                        | no      |
| plugins        | `immich_plugins`        | 4          | Plugins                                                                                                                                                     | no      |
| workflows      | `immich_workflows`      | 8          | Workflows                                                                                                                                                   | no      |
| cluster-groups | `immich_cluster_groups` | 8          | Cluster groups                                                                                                                                              | no      |

Example. List albums, then create one after previewing:

```json
{ "action": "get_all_albums" }
```

```json
{ "action": "create_album", "body": { "albumName": "Trip" } }
```

```json
{ "action": "create_album", "body": { "albumName": "Trip" }, "confirm": true }
```

## Live check

`npm run live-check` talks to a real Immich when `IMMICH_URL` and `IMMICH_API_KEY` are set. It exercises read tools and confirm-gated create, modify and delete cycles for albums, tags, assets (upload, download, update, delete), memories, shared links and API keys. If those variables are unset, it prints a skip message and exits 0.

`LIVE-CHECK.md` records the real run (Immich v3.3.0-rc.0 built from source on the box, failed=0) and lists what was not exercised live.

## License

MIT, see [LICENSE](LICENSE). This is an independent, unofficial connector and is not endorsed by the Immich project or its owners.

The upstream immich.openapi.json comes from a AGPL-3.0 project, so it is not shipped here. `src/operations.ts` was generated from it, and tests fall back to a route-only fixture in `test/fixtures/`. To regenerate, download the spec from the upstream project into the repo root (it is gitignored) and run `node scripts/gen-operations.mjs`.
