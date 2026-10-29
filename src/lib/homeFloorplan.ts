/**
 * The Home's floor plan belongs to the property, not to an owner: it survives ownership transfer
 * and deregistration, and is completed (never discarded) when rooms are added or removed.
 * Presentation only: it cannot create Area or device authority. Pure, no imports, unit tested.
 */

export const FLOORPLAN_COLUMNS = 48;
export const FLOORPLAN_ROWS = 64;

export type FloorplanRoom = { areaId: string; x: number; y: number; width: number; height: number };

const overlaps = (a: FloorplanRoom, b: FloorplanRoom) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const inGrid = (room: FloorplanRoom) =>
  room.x >= 0 && room.y >= 0 && room.width >= 1 && room.height >= 1
  && room.x + room.width <= FLOORPLAN_COLUMNS && room.y + room.height <= FLOORPLAN_ROWS;

/** Whole-cell shared wall length between two rooms that do not overlap. */
function sharedWall(a: FloorplanRoom, b: FloorplanRoom): number {
  if (overlaps(a, b)) return 0;
  const span = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  if (a.x + a.width === b.x || b.x + b.width === a.x) return span(a.y, a.y + a.height, b.y, b.y + b.height);
  if (a.y + a.height === b.y || b.y + b.height === a.y) return span(a.x, a.x + a.width, b.x, b.x + b.width);
  return 0;
}

/**
 * A tidy plan with no gaps for a Home that has none saved: rooms in a grid that fills the plan, each
 * sharing a wall with its neighbours.
 */
export function starterFloorplan(areaIds: string[]): FloorplanRoom[] {
  if (!areaIds.length) return [];
  const columns = Math.min(FLOORPLAN_COLUMNS, Math.max(1, Math.ceil(Math.sqrt(areaIds.length))));
  const rows = Math.ceil(areaIds.length / columns);
  const width = Math.max(1, Math.floor(FLOORPLAN_COLUMNS / columns));
  const height = Math.max(1, Math.floor(FLOORPLAN_ROWS / rows));
  return areaIds.map((areaId, index) => ({ areaId, x: (index % columns) * width, y: Math.floor(index / columns) * height, width, height }));
}

function parseRooms(document: unknown, known: ReadonlySet<string>): FloorplanRoom[] {
  const root = document && typeof document === 'object' && !Array.isArray(document) ? document as { version?: unknown; areas?: unknown } : null;
  if (root?.version !== 1 || !Array.isArray(root.areas)) return [];
  const kept: FloorplanRoom[] = [];
  for (const item of root.areas) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.areaId !== 'string' || !known.has(row.areaId) || kept.some((room) => room.areaId === row.areaId)) continue;
    if (![row.x, row.y, row.width, row.height].every(Number.isInteger)) continue;
    const room: FloorplanRoom = { areaId: row.areaId, x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height) };
    if (!inGrid(room) || kept.some((other) => overlaps(room, other))) continue;
    kept.push(room);
  }
  return kept;
}

/** Puts a room that has no place yet next to the rooms already on the plan, sharing a wall with one of them. */
function place(kept: FloorplanRoom[], areaId: string): FloorplanRoom | null {
  const free = (room: FloorplanRoom) => inGrid(room) && !kept.some((other) => overlaps(room, other));
  for (const size of [12, 8, 6, 4, 3]) {
    const candidates: FloorplanRoom[] = [];
    for (const r of kept) {
      for (const y of [r.y, r.y + r.height - size]) {
        candidates.push({ areaId, x: r.x + r.width, y, width: size, height: size }, { areaId, x: r.x - size, y, width: size, height: size });
      }
      for (const x of [r.x, r.x + r.width - size]) {
        candidates.push({ areaId, x, y: r.y + r.height, width: size, height: size }, { areaId, x, y: r.y - size, width: size, height: size });
      }
    }
    const fits = candidates.filter((room) => free(room) && kept.some((other) => sharedWall(room, other) >= Math.min(3, size)))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    if (fits[0]) return fits[0];
  }
  // Nothing attaches: take the first free cell block that fits.
  for (const size of [8, 4, 2, 1]) {
    for (let y = 0; y + size <= FLOORPLAN_ROWS; y += 1) {
      for (let x = 0; x + size <= FLOORPLAN_COLUMNS; x += 1) {
        const room = { areaId, x, y, width: size, height: size };
        if (free(room)) return room;
      }
    }
  }
  return null;
}

/**
 * The plan to show for a Home: every saved room that is still valid keeps its place; rooms that have
 * no place (added since, or whose saved place was invalid) are placed next to the rest. Only a Home
 * with no usable saved room at all gets the starter layout.
 */
export function completeFloorplan(areaIds: string[], document: unknown): FloorplanRoom[] {
  const known = new Set(areaIds);
  const kept = parseRooms(document, known);
  if (!kept.length) return starterFloorplan(areaIds);
  for (const areaId of areaIds) {
    if (kept.some((room) => room.areaId === areaId)) continue;
    const placed = place(kept, areaId);
    // The saved plan leaves no space at all: only then is it replaced, so no room is ever lost or overlapped.
    if (!placed) return starterFloorplan(areaIds);
    kept.push(placed);
  }
  return kept;
}
