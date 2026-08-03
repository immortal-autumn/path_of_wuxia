import type { WorldStatus } from "./types";

export function formatChinaTime(now: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(now).replaceAll("/", "-");
}

export function createWorldStatus(
  base: { announcement: string },
  onlineCount: number,
  now = new Date(),
): WorldStatus {
  return {
    timeZone: "Asia/Shanghai",
    dateTime: formatChinaTime(now),
    announcement: base.announcement,
    onlineCount,
    serverTime: now.toISOString(),
  };
}

export function worldStatusKey(world: WorldStatus) {
  return `${world.onlineCount}:${world.dateTime.slice(0, 16)}`;
}
