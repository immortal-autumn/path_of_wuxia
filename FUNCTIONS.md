# Project Functions

This is the canonical inventory of implemented project behavior. Update it in the same change whenever a function is added, changed, renamed, or removed.

## Application entries

| Entry | Function | Persistence / real-time | Automated coverage |
| --- | --- | --- | --- |
| `/` | Loads the shared-world game from玄关 and renders China time, a layer-local square-node map, actions, attribute/combat/cultivation status, and chat. | Reads a local SQLite neighborhood from the 500+ location source-tracked world and authoritative progression; opens `/ws`. | Unit world validation/progression tests and Playwright game, direction-control, multiplayer, and mobile tests. |
| `/map-editor` | Loads the collaborative drag/drop map designer with chunk controls, inspector, locks, and history. | Reads bounded map viewports and writes through authenticated WebSocket commands. | Playwright drop, route, undo/redo, region-drag, and lock-contention tests. |
| `/api/session` | Restores or creates a random player and HttpOnly browser session, then performs a same-origin redirect. | Writes `players`, `sessions`, and an arrival event. | Unit identity test and Playwright entry test. |
| `/ws` | Authenticates the session and runs game, chat, presence, map viewport, lock, editing, and history protocols. | Uses SQLite transactions and broadcasts incremental invalidations. | Live smoke and Playwright real-time/editor tests. |

## Player and world functions

| Function | Interface | Behavior | Automated coverage |
| --- | --- | --- | --- |
| Automatic identity | First browser visit | Creates a collision-safe random identity at `home-entrance`; browser contexts remain distinct. | Unit 2,000-name test and Playwright identity test. |
| China-standard time | World panel / `world.updated` | Displays an `Asia/Shanghai` `YYYY-MM-DD HH:mm:ss` clock synchronized from server time. | Unit deterministic-time and Playwright world tests. |
| Three-step neighborhood | Game map | Queries only current-layer ordinary-route graph depth ≤3; cross-layer connections remain action-only and the response includes only relevant regions/routes/actions. | Unit seed/neighborhood and Playwright layer-local map tests. |
| Eight-direction movement | Map box / `move` | Ordinary routes connect one adjacent grid cell in eight directions; movement and ordinary actions never check or consume endurance. | Unit free-movement/direction tests and Playwright seed-tour tests. |
| Explicit direction controls | Boxed “下一步” buttons | Lists each currently adjacent direction and destination, disables movement while offline or pending, and sends the same validated `move` command as a square map node. | Playwright square-node and direction-control test. |
| Plain-HTTP browser compatibility | Game and map-editor commands | Generates collision-resistant client request/entity IDs with `crypto.getRandomValues` and a legacy fallback, so movement and editing work when `crypto.randomUUID` is unavailable. | Playwright no-`randomUUID` movement and editor tests. |
| Layer transitions and portals | Action panel / `move` | Doors, stairs, gates and portals connect map layers without consuming direction slots; only normal routes appear in the local SVG. | Unit cross-layer transition tests and Playwright house/Song/Palos tour. |
| Six-attribute progression | Character tabs / `attributes.allocate` | Stores strength, agility, constitution, root, comprehension and spirit; atomically spends permanent points and recalculates transparent combat values. | Unit formulas/scaling/atomic-allocation tests and Playwright allocation test. |
| Cultivation and breakthroughs | Training locations / `cultivation.breakthrough` | Settles unlimited online/offline cultivation from server time, auto-levels within a realm, and applies 45/60/75/100% breakthroughs with failure cost and 30% carry. | Unit clock/idempotency/failure/success/reward tests and Playwright training/offline/100% breakthrough tests. |
| Derived combat panel | Character “战斗属性” tab | Computes HP, endurance, min/max attack, defense, speed, hit, dodge, critical rate/damage and cultivation speed from attributes and realm. | Unit deterministic-formula and Playwright derived-panel tests. |
| Location actions | Action button / `act` | Applies validated HP/silver effects atomically without endurance costs or observation cultivation rewards. | Unit free-action and Playwright seed-tour tests. |
| World chat | Chat form / `chat.send` | Normalizes, rate-limits, persists, and broadcasts 1–120 character messages. | Unit chat, live smoke, and Playwright multiplayer tests. |
| Online presence | WebSocket lifecycle | Deduplicates players, broadcasts online count, and shows local player positions. | Live smoke and Playwright multiplayer tests. |
| Mobile drawers | Mobile navigation | Keeps the map primary and opens world, action, character, and chat drawers. | Playwright 390×844 test. |

## Map design functions

| Function | Interface | Behavior | Automated coverage |
| --- | --- | --- | --- |
| Region editing | Drag palette, canvas, inspector | Creates, drags, resizes, updates, and safely soft-deletes large region boxes. | Unit operation tests and Playwright region-drag test. |
| Grid location editing | Drag palette and location boxes | Snaps to the nearest unique grid cell, assigns a containing region, auto-adds an Observe action, and auto-saves. | Unit collision test and Playwright HTML5-drop test. |
| Direction slots | Normal-route editor | Atomically reserves reciprocal direction slots; each location has at most one route per direction. | Unit direction-slot test and Playwright route test. |
| Edit leases | Automatic scope acquisition / Finish Editing | Locks regions or public chunks, renews every30 seconds, expires after two minutes, and blocks other players. | Unit expiry/exclusion and Playwright contention tests. |
| Undo/redo | Editor toolbar / map history protocol | Stores the latest50 inverse operations within the active edit lease. | Unit save/undo/redo and Playwright history test. |
| Chunk loading | Viewport controls / `map.viewport.subscribe` | Loads9/25/49 chunks, returns aggregates at low zoom, and caps detailed responses at1200 locations. | Unit payload-cap test and 50k benchmark. |
| Incremental synchronization | `map.chunks.invalidated` | Broadcasts affected chunk keys; clients reload only bounded local data. | Playwright editor-to-game visibility test. |
| Safe map schema upgrades | SQLite startup migration | Upgrades populated legacy databases despite SQLite `ALTER TABLE` foreign-key limits and preserves active version-3 locations/routes while installing later schema and seeds. | Unit populated-v1 and v3→v4 upgrade regression tests. |
| Layered map storage | `map_layers`, layer-scoped chunks and editor layer selector | Separates world, house, Northern Song and Palos maps; ordinary grid occupancy is unique within a layer. | Unit v3→v4 migration, viewport and transition tests. |
| Layer hierarchy editing | Editor layer forms / `map.edit` | Creates, renames, reparents and deletes empty custom layers under edit leases; rejects self/descendant cycles and protects initial layers. | Unit layer lifecycle/cycle test and Playwright layer-create/update/delete test. |
| Cross-layer target search | Editor connection form / `map.locations.search` | Searches at most 200 active locations in a selected layer, then creates typed door/stairs/elevator/gate/road/ferry/dungeon/fast-travel/portal connections without using direction slots. | Unit bounded location-search/transition test and Playwright cross-layer connection test. |
| Source-tracked complete demo world | SQLite startup / `npm run map:seed` | Idempotently installs a 29-location modern house, 250+ Northern Song nodes and 267 public Palworld markers with stable IDs, source URL/version/retrieval date, hierarchical layers and full reachability from玄关. | Unit idempotent-import and `validateWorldMap` topology/source/count tests. |
| Map integrity validation | `npm run map:validate` | Checks layer cycles, source records, eight-direction adjacency, reciprocal direction slots, cross-layer transitions, training-room effect, 500+/per-world minimums and full reachability. | Unit source-tracked seed validation test; command exits non-zero on errors. |

## Callable protocol messages

| Direction | Messages |
| --- | --- |
| Client → server | `sync`, `move`, `act`, `attributes.allocate`, `cultivation.breakthrough`, `chat.send`, `ping`, `map.viewport.subscribe`, `map.locations.search`, `map.lock.acquire/renew/release`, `map.edit`, `map.history.undo/redo` |
| Server → client | `snapshot`, `ack`, `self.updated`, `cultivation.updated`, `players.updated`, `world.event`, `chat.message`, `world.updated`, `map.viewport.snapshot`, `map.locations.result`, `map.edit.session`, `map.history.state`, `map.chunks.invalidated`, `map.locks.updated`, `error`, `pong` |

## Operations and verification functions

| Command | Function |
| --- | --- |
| `npm run dev` | Runs the custom Next.js and WebSocket development server. |
| `npm run build` | Builds the Next.js application and custom server. |
| `npm start` | Runs the production custom server. |
| `npm run lint` | Runs ESLint. |
| `npm test` | Runs SQLite, game, direction, editor, lock, history, and chunk unit tests. |
| `npm run test:e2e` | Builds and runs the production-backed Playwright game/editor suite. |
| `npm run test:all` | Runs unit and Playwright suites. |
| `npm run smoke:live` | Verifies two-client chat and movement against a running server. |
| `npm run db:backup` | Creates an online SQLite backup. |
| `npm run map:seed` | Idempotently imports the bundled source-tracked house, Northern Song and Palworld world, validates it, and prints a JSON report. |
| `npm run map:validate` | Validates the active SQLite world topology, provenance, minimum location counts and reachability. |
| `npm run map:seed-load -- --locations=50000` | Generates repeatable large-map data and reports indexed viewport-query performance. |
