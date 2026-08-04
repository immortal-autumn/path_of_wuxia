import type { DatabaseSync } from "node:sqlite";

export type NpcScheduleDirective = {
  scheduleEntryId: string | null;
  activity: string | null;
  targetLocationId: string | null;
} & (
  | { kind: "move"; locationId: string }
  | { kind: "action"; actionId: string }
  | { kind: "hold"; reason: "no-schedule" | "invalid-target" | "unreachable" | "at-target" }
);

type ScheduleEntryRow = {
  id: string;
  start_minute: number;
  end_minute: number;
  activity_kind: string;
  target_kind: "home" | "workplace" | "fixed" | "route";
  target_location_id: string | null;
  route_id: string | null;
  home_location_id: string;
  workplace_location_id: string;
};

type RouteStopRow = { location_id: string; dwell_minutes: number };
type RouteEdgeRow = { id: string; from_location: string; to_location: string };

const WEEKDAY_BITS: Record<string, number> = {
  Mon: 1 << 0,
  Tue: 1 << 1,
  Wed: 1 << 2,
  Thu: 1 << 3,
  Fri: 1 << 4,
  Sat: 1 << 5,
  Sun: 1 << 6,
};

const ACTIVITY_ACTIONS: Record<string, string[]> = {
  "歇宿": ["action-sleep", "action-rest"],
  "晨起": ["action-observe", "action-listen"],
  "当值": ["action-work-shift", "action-observe", "action-listen"],
  "营生": ["action-work-shift", "action-observe", "action-listen"],
  "晚间行止": ["action-observe", "action-listen", "action-rest"],
  "归家": ["action-sleep", "action-rest", "action-observe"],
};

function chinaScheduleClock(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "0";
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  const second = Number(value("second"));
  return {
    weekdayBit: WEEKDAY_BITS[value("weekday")] ?? 0,
    minuteOfDay: hour * 60 + minute,
    secondOfDay: (hour * 60 + minute) * 60 + second,
  };
}

function routeStopTarget(db: DatabaseSync, entry: ScheduleEntryRow, minuteOfDay: number) {
  if (!entry.route_id) return null;
  const route = db.prepare("SELECT loop FROM npc_routes WHERE id=? AND is_active=1").get(entry.route_id) as {
    loop: number;
  } | undefined;
  if (!route) return null;
  const stops = db.prepare(`
    SELECT stop.location_id,stop.dwell_minutes
    FROM npc_route_stops stop JOIN locations location ON location.id=stop.location_id
    WHERE stop.route_id=? AND location.is_active=1 ORDER BY stop.sequence
  `).all(entry.route_id) as RouteStopRow[];
  if (stops.length === 0) return null;
  const totalMinutes = stops.reduce((total, stop) => total + stop.dwell_minutes, 0);
  if (totalMinutes <= 0) return stops[0].location_id;
  const elapsed = Math.max(0, minuteOfDay - entry.start_minute);
  let offset = route.loop === 1 ? elapsed % totalMinutes : Math.min(elapsed, totalMinutes - 1);
  for (const stop of stops) {
    if (offset < stop.dwell_minutes) return stop.location_id;
    offset -= stop.dwell_minutes;
  }
  return stops.at(-1)?.location_id ?? null;
}

function scheduleTarget(db: DatabaseSync, entry: ScheduleEntryRow, minuteOfDay: number) {
  if (entry.target_kind === "home") return entry.home_location_id;
  if (entry.target_kind === "workplace") return entry.workplace_location_id;
  if (entry.target_kind === "route") return routeStopTarget(db, entry, minuteOfDay);
  return entry.target_location_id;
}

export function nextLegalNpcScheduleHop(db: DatabaseSync, fromLocationId: string, targetLocationId: string) {
  if (fromLocationId === targetLocationId) return null;
  const rows = db.prepare(`
    SELECT route.id,route.from_location,route.to_location
    FROM routes route
    JOIN locations origin ON origin.id=route.from_location AND origin.is_active=1
    JOIN locations destination ON destination.id=route.to_location AND destination.is_active=1
    WHERE route.is_active=1 AND route.route_type IN ('normal','transition')
    ORDER BY route.id,route.from_location,route.to_location
  `).all() as RouteEdgeRow[];
  const adjacency = new Map<string, Array<{ routeId: string; locationId: string }>>();
  for (const row of rows) {
    adjacency.set(row.from_location, [
      ...(adjacency.get(row.from_location) ?? []),
      { routeId: row.id, locationId: row.to_location },
    ]);
    adjacency.set(row.to_location, [
      ...(adjacency.get(row.to_location) ?? []),
      { routeId: row.id, locationId: row.from_location },
    ]);
  }
  for (const edges of adjacency.values()) {
    edges.sort((left, right) => left.routeId.localeCompare(right.routeId) || left.locationId.localeCompare(right.locationId));
  }

  const visited = new Set([fromLocationId]);
  const queue: Array<{ locationId: string; firstHop: string }> = [];
  for (const edge of adjacency.get(fromLocationId) ?? []) {
    if (visited.has(edge.locationId)) continue;
    if (edge.locationId === targetLocationId) return edge.locationId;
    visited.add(edge.locationId);
    queue.push({ locationId: edge.locationId, firstHop: edge.locationId });
  }
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const edge of adjacency.get(current.locationId) ?? []) {
      if (visited.has(edge.locationId)) continue;
      if (edge.locationId === targetLocationId) return current.firstHop;
      visited.add(edge.locationId);
      queue.push({ locationId: edge.locationId, firstHop: current.firstHop });
    }
  }
  return null;
}

function scheduledAction(
  db: DatabaseSync,
  locationId: string,
  activity: string,
  remainingSeconds: number,
) {
  const preferred = ACTIVITY_ACTIONS[activity] ?? ["action-observe", "action-listen"];
  const rows = db.prepare(`
    SELECT template.id,template.duration_seconds
    FROM location_action_bindings binding
    JOIN action_templates template ON template.id=binding.action_template_id
    WHERE binding.location_id=? AND binding.is_active=1 AND template.is_active=1
      AND template.adult=0 AND template.target_kind IN ('self','location')
    ORDER BY binding.priority DESC,template.id
  `).all(locationId) as Array<{ id: string; duration_seconds: number }>;
  const available = new Map(rows.map((row) => [row.id, row]));
  return preferred.find((id) => {
    const action = available.get(id);
    return action !== undefined && action.duration_seconds <= remainingSeconds;
  }) ?? null;
}

export function resolveNpcScheduleDirective(db: DatabaseSync, playerId: string, at = new Date()): NpcScheduleDirective {
  const player = db.prepare(`
    SELECT player.current_location FROM players player
    JOIN npc_profiles profile ON profile.player_id=player.id
    WHERE player.id=? AND player.controller_kind='npc'
  `).get(playerId) as { current_location: string } | undefined;
  const clock = chinaScheduleClock(at);
  if (!player || clock.weekdayBit === 0) {
    return { kind: "hold", reason: "no-schedule", scheduleEntryId: null, activity: null, targetLocationId: null };
  }
  const entry = db.prepare(`
    SELECT schedule.id,schedule.start_minute,schedule.end_minute,schedule.activity_kind,
      schedule.target_kind,schedule.target_location_id,schedule.route_id,
      assignment.home_location_id,assignment.workplace_location_id
    FROM npc_schedule_entries schedule
    JOIN npc_assignments assignment ON assignment.player_id=schedule.player_id
    WHERE schedule.player_id=? AND (schedule.weekday_mask & ?)<>0
      AND schedule.start_minute<=? AND schedule.end_minute>?
    ORDER BY schedule.start_minute DESC,schedule.id LIMIT 1
  `).get(playerId, clock.weekdayBit, clock.minuteOfDay, clock.minuteOfDay) as ScheduleEntryRow | undefined;
  if (!entry) {
    return { kind: "hold", reason: "no-schedule", scheduleEntryId: null, activity: null, targetLocationId: null };
  }
  const targetLocationId = scheduleTarget(db, entry, clock.minuteOfDay);
  const common = { scheduleEntryId: entry.id, activity: entry.activity_kind, targetLocationId };
  if (!targetLocationId || !db.prepare("SELECT 1 FROM locations WHERE id=? AND is_active=1").get(targetLocationId)) {
    return { ...common, kind: "hold", reason: "invalid-target" };
  }
  if (player.current_location !== targetLocationId) {
    const locationId = nextLegalNpcScheduleHop(db, player.current_location, targetLocationId);
    return locationId
      ? { ...common, kind: "move", locationId }
      : { ...common, kind: "hold", reason: "unreachable" };
  }
  const remainingSeconds = entry.end_minute * 60 - clock.secondOfDay;
  const actionId = scheduledAction(db, targetLocationId, entry.activity_kind, remainingSeconds);
  return actionId
    ? { ...common, kind: "action", actionId }
    : { ...common, kind: "hold", reason: "at-target" };
}
