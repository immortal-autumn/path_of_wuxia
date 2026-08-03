import type { Direction, Location } from "./types";

export const GRID_SIZE = 160;
export const CHUNK_SIZE = 1000;

export const DIRECTION_DELTAS: Record<Direction, readonly [number, number]> = {
  up: [0, -1],
  "up-right": [1, -1],
  right: [1, 0],
  "down-right": [1, 1],
  down: [0, 1],
  "down-left": [-1, 1],
  left: [-1, 0],
  "up-left": [-1, -1],
};

export const OPPOSITE_DIRECTION: Record<Direction, Direction> = {
  up: "down",
  "up-right": "down-left",
  right: "left",
  "down-right": "up-left",
  down: "up",
  "down-left": "up-right",
  left: "right",
  "up-left": "down-right",
};

export const DIRECTION_LABEL: Record<Direction, string> = {
  up: "上",
  "up-right": "右上",
  right: "右",
  "down-right": "右下",
  down: "下",
  "down-left": "左下",
  left: "左",
  "up-left": "左上",
};

export function directionBetween(from: Pick<Location, "gridX" | "gridY">, to: Pick<Location, "gridX" | "gridY">) {
  const dx = to.gridX - from.gridX;
  const dy = to.gridY - from.gridY;
  return (Object.entries(DIRECTION_DELTAS).find(([, delta]) => delta[0] === dx && delta[1] === dy)?.[0] ?? null) as
    | Direction
    | null;
}

export function gridToWorldPosition(gridX: number, gridY: number) {
  return { x: gridX * GRID_SIZE, y: gridY * GRID_SIZE };
}

export function worldToGridPosition(x: number, y: number) {
  return { gridX: Math.round(x / GRID_SIZE), gridY: Math.round(y / GRID_SIZE) };
}

export function chunkForGrid(gridX: number, gridY: number) {
  return {
    chunkX: Math.floor((gridX * GRID_SIZE) / CHUNK_SIZE),
    chunkY: Math.floor((gridY * GRID_SIZE) / CHUNK_SIZE),
  };
}

export function chunkKey(chunkX: number, chunkY: number) {
  return `${chunkX}:${chunkY}`;
}

export function locationScope(location: Pick<Location, "regionId" | "chunkX" | "chunkY">) {
  return location.regionId ? `region:${location.regionId}` : `chunk:${chunkKey(location.chunkX, location.chunkY)}`;
}
