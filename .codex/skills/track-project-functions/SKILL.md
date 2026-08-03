---
name: track-project-functions
description: Keep this repository's root FUNCTIONS.md synchronized with implemented behavior. Use whenever adding, changing, renaming, or removing a user-facing feature, route, WebSocket command or event, game rule, persistence behavior, operational command, or automated test surface.
---

# Track Project Functions

Treat `FUNCTIONS.md` in the repository root as the canonical capability inventory.

## Required workflow

1. Read `FUNCTIONS.md` before implementation and identify the affected entries.
2. Implement the behavior and its automated coverage.
3. Add or update the corresponding `FUNCTIONS.md` entry in the same change. Remove entries for deleted behavior.
4. Record the public entry point or interface, observable behavior, persistence or real-time effects, and the test that verifies it.
5. Run the relevant unit, Playwright, lint, type, and build checks before handoff.

Track product and runtime capabilities rather than private one-use helper functions. Always include routes, WebSocket protocol messages, player actions, scripts, and test commands because they are externally callable project functions.
