# Project Functions

This is the canonical inventory of implemented project behavior. Update it in the same change whenever a function is added, changed, renamed, or removed.

## Application entries

| Entry | Function | Persistence / real-time | Automated coverage |
| --- | --- | --- | --- |
| `/` | Loads the shared-world game from玄关 and renders China time, a text-only square-node view of the continuous overworld or current interior, actions, attribute/combat/cultivation status, and chat. | Reads a local SQLite neighborhood from the 900+ location source-tracked world and authoritative progression; opens `/ws`. | Unit world validation/progression tests and Playwright continuous-world tour, direction-control, multiplayer, responsive-layout, and mobile-drawer tests. |
| `/map-editor` | Loads the responsive collaborative drag/drop designer for the continuous overworld and exceptional interior maps, with a concise canvas-status bar, text-only square locations, chunk controls, inspector, locks, and history. | Reads bounded map viewports and writes through authenticated WebSocket commands. | Playwright six-map inventory, responsive layout, drop, route, undo/redo, region-drag, and lock-contention tests. |
| `/api/session` | Restores or creates a random player and HttpOnly browser session, then performs a same-origin redirect. | Writes `players`, `sessions`, and an arrival event. | Unit identity test and Playwright entry test. |
| `/ws` | Authenticates the session and runs game, chat, presence, map viewport, lock, editing, and history protocols. | Uses SQLite transactions and broadcasts incremental invalidations. | Live smoke and Playwright real-time/editor tests. |

## Player and world functions

| Function | Interface | Behavior | Automated coverage |
| --- | --- | --- | --- |
| Automatic identity | First browser visit | Creates a collision-safe random identity at `home-entrance`; browser contexts remain distinct. | Unit 2,000-name test and Playwright identity test. |
| China-standard time | World panel / `world.updated` | Displays an `Asia/Shanghai` `YYYY-MM-DD HH:mm:ss` clock synchronized from server time. | Unit deterministic-time and Playwright world tests. |
| Three-step neighborhood | Game map | Queries only current-map ordinary-route graph depth ≤3; the fitted viewport is calculated from those locations alone, while current location, pointed full name, area, visible count and nearby presence appear in an external map-information strip. Cross-map connections remain action-only. | Unit seed/neighborhood and Playwright text-only node, overflow, local map and external-status tests. |
| Concise map labels | Game and editor location squares | Derives a map-only label of at most nine characters by removing repeated house/region/category prefixes and compacting generated cave/memo names. Canonical full names remain unchanged in SQLite, commands, accessibility labels, game hover/focus status, editor selection status and inspector fields. | Unit exact-label/truncation tests and Playwright compact-node/full-status tests. |
| Continuous public overworld | `world-root` ordinary-route graph | Places the house exterior, 楼门路, all 618 sourced Northern Song nodes and all 279 sourced Palos nodes on one large chunked map. Westward/eastward serpentine roads preserve eight-direction adjacency; ordinary movement crosses public regions without overview/category transitions. | Unit flattened-layer/topology/migration validation and Playwright Song-to-Palos continuous-world tour. |
| Eight-direction movement | Map box / `move` | Ordinary routes connect one adjacent grid cell in eight directions; movement and ordinary actions never check or consume endurance. | Unit free-movement/direction tests and Playwright seed-tour tests. |
| Explicit direction controls | Boxed “下一步” footer | Lists each currently adjacent direction and destination outside the SVG, disables movement while offline or pending, and sends the same validated `move` command as a square map node. | Playwright square-node and direction-control test. |
| Plain-HTTP browser compatibility | Game and map-editor commands | Generates collision-resistant client request/entity IDs with `crypto.getRandomValues` and a legacy fallback, so movement and editing work when `crypto.randomUUID` is unavailable. | Playwright no-`randomUUID` movement and editor tests. |
| Interior transitions and portals | Action panel / `move` | Doors, stairs and portals are reserved for genuine interiors or custom exceptional maps, including the overworld house entrance; public Song and Palos travel uses ordinary routes. | Unit same-layer/cross-layer route tests and Playwright house/continuous-overworld tour. |
| Six-attribute progression | Character tabs / `attributes.allocate` | Stores strength, agility, constitution, root, comprehension and spirit; atomically spends permanent points and recalculates transparent combat values. | Unit formulas/scaling/atomic-allocation tests and Playwright allocation test. |
| Cultivation and breakthroughs | Training locations / `cultivation.breakthrough` | Settles unlimited online/offline cultivation from server time, auto-levels within a realm, and applies 45/60/75/100% breakthroughs with failure cost and 30% carry. | Unit clock/idempotency/failure/success/reward tests and Playwright training/offline/100% breakthrough tests. |
| Derived combat panel | Character “战斗属性” tab | Computes HP, endurance, min/max attack, defense, speed, hit, dodge, critical rate/damage and cultivation speed from attributes and realm. | Unit deterministic-formula and Playwright derived-panel tests. |
| Location actions | Action button / `act` | Applies validated HP/silver effects atomically without endurance costs or observation cultivation rewards. | Unit free-action and Playwright seed-tour tests. |
| World chat | Chat form / `chat.send` | Normalizes, rate-limits, persists, and broadcasts 1–120 character messages. | Unit chat, live smoke, and Playwright multiplayer tests. |
| Online presence | WebSocket lifecycle | Deduplicates players, broadcasts online count, and shows local player positions. | Live smoke and Playwright multiplayer tests. |
| Responsive game workspace | Desktop panels / mobile navigation | Keeps headings, external map status, a pannable map stage and direction footer in document flow; wraps action text, scrolls dense character/chat content internally, prevents page-level horizontal overflow, and opens world/action/character/chat drawers on mobile. | Playwright desktop map-layout and 390×844 overflow/drawer tests. |

## Map design functions

| Function | Interface | Behavior | Automated coverage |
| --- | --- | --- | --- |
| Region editing | Drag palette, canvas, inspector | Creates, drags, resizes, updates, and safely soft-deletes large region boxes. | Unit operation tests and Playwright region-drag test. |
| Grid location editing | Drag palette and location boxes | Snaps to the nearest unique grid cell, assigns a containing region, auto-adds an Observe action, and auto-saves. | Unit collision test and Playwright HTML5-drop test. |
| Direction slots | Normal-route editor | Atomically reserves reciprocal direction slots; each location has at most one route per direction. | Unit direction-slot test and Playwright route test. |
| Edit leases | Automatic scope acquisition / Finish Editing | Locks regions or public chunks only when a drag changes coordinates or a save mutates data; selection-only clicks remain lock-free. Leases renew every30 seconds, expire after two minutes, and block other players. | Unit expiry/exclusion and Playwright selection-without-lock/contention tests. |
| Undo/redo | Editor toolbar / map history protocol | Stores the latest50 inverse operations within the active edit lease. | Unit save/undo/redo and Playwright history test. |
| Indexed chunk loading | Viewport controls / `map.viewport.subscribe` | Loads the exact requested 9/25/49 chunk keys through the composite `(layer,active,chunkX,chunkY,id)` index, returns aggregates at low zoom, and caps detailed responses at1200 locations. | Unit payload-cap/index-plan test and 50k benchmark. |
| Incremental synchronization | `map.chunks.invalidated` | Broadcasts affected chunk keys; clients reload only bounded local data. | Playwright editor-to-game visibility test. |
| Safe map schema upgrades | SQLite startup migration | Upgrades populated legacy databases despite SQLite `ALTER TABLE` foreign-key limits and preserves active version-3 locations/routes while installing later schema and seeds. | Unit populated-v1 and v3→v4 upgrade regression tests. |
| Layered exceptional-map storage | `map_layers`, layer-scoped chunks and editor map selector | Keeps one public `world-root` plus five house maps; ordinary grid occupancy remains unique per map, and user-created interiors remain supported. | Unit revision-3 flattening, viewport and transition tests; Playwright six-map inventory. |
| Exceptional-map editing | Editor map forms / `map.edit` | Creates, renames, reparents and deletes empty custom interior/special maps under edit leases; rejects self/descendant cycles and protects initial maps. | Unit layer lifecycle/cycle test and Playwright map-create/update/delete test. |
| Cross-map target search | Editor connection form / `map.locations.search` | Searches at most 200 active locations in a selected map, then creates typed door/stairs/elevator/gate/road/ferry/dungeon/fast-travel/portal connections without using direction slots. | Unit bounded location-search/transition test and Playwright cross-map connection test. |
| Responsive editor workspace | Editor tools / canvas / inspector | Uses internally scrolling side panels on wide screens and a single-column, page-contained workspace at 1050px and below; its map canvas pans internally on narrow screens. Compact 100-unit square editor locations contain only concise labels while the full selection name, grid coordinates, loaded chunks and zoom appear outside the SVG. | Playwright node-size/concise-label, selection-summary and 768px overflow test. |
| Source-tracked complete demo world | SQLite startup / `npm run map:seed` | Idempotently installs 31 sourced modern house/entrance locations, 618 sourced Northern Song nodes and 279 sourced Palos nodes with stable IDs, source URL/version/retrieval date, one continuous public layer and full reachability from玄关. Revision 3 deactivates obsolete revisioned hierarchy records plus the three reserved pre-revision artifacts, while preserving genuinely user-created content. | Unit idempotent import, revision-0/2 flattening upgrade and `validateWorldMap` topology/source/count tests. |
| Map integrity validation | `npm run map:validate` | Checks layer cycles, canonical seed layers, public-location flattening, source records, eight-direction adjacency, reciprocal direction slots, interior transitions, training-room effect, 500+/per-world minimums and full reachability. | Unit source-tracked flat-world validation test; command exits non-zero on errors. |

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
| `npm run lint` | Runs ESLint across project source, configuration, scripts and tests while excluding generated Next.js, server-build and Playwright-report artifacts. |
| `npm test` | Runs SQLite, game, direction, editor, lock, history, and chunk unit tests. |
| `npm run test:e2e` | Builds and runs the production-backed Playwright game/editor suite. |
| `npm run test:all` | Runs unit and Playwright suites. |
| `npm run smoke:live` | Verifies two-client chat and movement against a running server. |
| `npm run db:backup` | Creates an online SQLite backup. |
| `npm run map:seed` | Idempotently imports the bundled source-tracked house, Northern Song and Palworld world, validates it, and prints a JSON report. |
| `npm run map:validate` | Validates the active SQLite world topology, provenance, minimum location counts and reachability. |
| `npm run map:seed-load -- --locations=50000` | Generates repeatable large-map data and reports the exact 49-chunk viewport query time and SQLite index plan. Use a temporary `DATABASE_PATH` for disposable benchmarks. |
