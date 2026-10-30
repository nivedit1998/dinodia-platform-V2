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


// ---- Floors -------------------------------------------------------------------------------------------------------
// A Home's plan can have several floors, each its own grid. Presentation only, like the rest of the plan. Stored as
// { version: 2, floors: [{ level, areas }] }; a plan saved before floors (version 1) is read as the Ground floor alone.
// The document sent to clients keeps version 1 and its `areas` list so apps built before floors still draw and save the
// Home exactly as they did; apps that know floors read `floors`.

/** Basement, Ground, then 1st to 5th. A fixed set, so a floor never needs a name. */
export const FLOOR_LEVELS: readonly number[] = [-1, 0, 1, 2, 3, 4, 5];

export type FloorplanFloor = { level: number; areas: FloorplanRoom[] };
export type FloorplanDocument = { version: 1; areas: FloorplanRoom[]; floors: FloorplanFloor[] };

const isLevel = (level: unknown): level is number => typeof level === 'number' && FLOOR_LEVELS.includes(level);

/** Rooms of one floor: valid places only, no room twice, no overlaps. */
function parseFloorRooms(items: unknown, known: ReadonlySet<string>, taken: Set<string>): FloorplanRoom[] {
  if (!Array.isArray(items)) return [];
  const kept: FloorplanRoom[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.areaId !== 'string' || !known.has(row.areaId) || taken.has(row.areaId)) continue;
    if (![row.x, row.y, row.width, row.height].every(Number.isInteger)) continue;
    const room: FloorplanRoom = { areaId: row.areaId, x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height) };
    if (!inGrid(room) || kept.some((other) => overlaps(room, other))) continue;
    kept.push(room);
    taken.add(room.areaId);
  }
  return kept;
}

function storedFloors(document: unknown, known: ReadonlySet<string>): FloorplanFloor[] {
  const root = document && typeof document === 'object' && !Array.isArray(document) ? document as { version?: unknown; areas?: unknown; floors?: unknown } : null;
  const taken = new Set<string>();
  const floors: FloorplanFloor[] = [];
  if (root?.version === 2 && Array.isArray(root.floors)) {
    const seenLevels = new Set<number>();
    for (const raw of root.floors) {
      const floor = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as { level?: unknown; areas?: unknown } : null;
      if (!floor || !isLevel(floor.level) || seenLevels.has(floor.level)) continue;
      seenLevels.add(floor.level);
      floors.push({ level: floor.level, areas: parseFloorRooms(floor.areas, known, taken) });
    }
  } else if (root?.version === 1 && Array.isArray(root.areas)) {
    floors.push({ level: 0, areas: parseFloorRooms(root.areas, known, taken) });
  }
  return floors;
}

/**
 * Every active room on exactly one floor. Saved places are kept; a room with no place (added since, or invalid) goes onto the
 * Ground floor next to the rest. A Home with nothing usable saved gets the starter layout on the Ground floor.
 */
export function completeFloors(areaIds: string[], document: unknown): FloorplanFloor[] {
  const known = new Set(areaIds);
  const floors = storedFloors(document, known);
  if (!floors.some((floor) => floor.level === 0)) floors.push({ level: 0, areas: [] });
  const placed = new Set(floors.flatMap((floor) => floor.areas.map((room) => room.areaId)));
  const missing = areaIds.filter((areaId) => !placed.has(areaId));
  const ground = floors.find((floor) => floor.level === 0)!;
  if (!placed.size) {
    ground.areas = starterFloorplan(areaIds);
  } else {
    for (const areaId of missing) {
      const spot = place(ground.areas, areaId);
      // The Ground floor has no space left: start it over rather than lose or overlap a room (other floors are untouched).
      if (!spot) { ground.areas = starterFloorplan([...ground.areas.map((room) => room.areaId), areaId]); continue; }
      ground.areas.push(spot);
    }
  }
  return floors.sort((a, b) => a.level - b.level);
}

/** What older apps see: the Ground floor as it is, and every room from other floors placed beside it, so nothing overlaps. */
export function legacyAreas(floors: FloorplanFloor[]): FloorplanRoom[] {
  const ground = floors.find((floor) => floor.level === 0)?.areas ?? [];
  const flat = ground.map((room) => ({ ...room }));
  for (const floor of floors) {
    if (floor.level === 0) continue;
    for (const room of floor.areas) {
      const spot = place(flat, room.areaId);
      if (spot) flat.push(spot);
    }
  }
  return flat;
}

/** The document clients receive, for the Home's active rooms. */
export function floorplanDocument(areaIds: string[], document: unknown): FloorplanDocument {
  const floors = completeFloors(areaIds, document);
  return { version: 1, areas: legacyAreas(floors), floors };
}

/** Whether a stored plan has any room on a floor other than the Ground floor. */
export function hasUpperFloors(document: unknown): boolean {
  const root = document && typeof document === 'object' && !Array.isArray(document) ? document as { version?: unknown; floors?: unknown } : null;
  if (root?.version !== 2 || !Array.isArray(root.floors)) return false;
  return root.floors.some((raw) => {
    const floor = raw && typeof raw === 'object' ? raw as { level?: unknown; areas?: unknown } : null;
    return !!floor && floor.level !== 0 && Array.isArray(floor.areas) && floor.areas.length > 0;
  });
}

export type FloorplanSubmission = { ok: true; stored: { version: 2; floors: FloorplanFloor[] } } | { ok: false; reason: 'INVALID' | 'FLOORS_NEED_NEW_APP' };

/**
 * Validates a plan saved by a client against the Home's current rooms and returns what to store. Either the new form
 * (`floors`) or the form older apps send (`areas`, which means the Ground floor). An older app may not overwrite a plan that
 * has rooms on other floors: that would silently drop them.
 */
export function submittedFloorplan(areaIds: string[], body: unknown, stored: unknown): FloorplanSubmission {
  const root = body && typeof body === 'object' && !Array.isArray(body) ? body as { version?: unknown; areas?: unknown; floors?: unknown } : null;
  if (!root || root.version !== 1) return { ok: false, reason: 'INVALID' };
  const known = new Set(areaIds);
  let floors: FloorplanFloor[];
  if (root.floors !== undefined) {
    if (!Array.isArray(root.floors) || root.floors.length < 1 || root.floors.length > FLOOR_LEVELS.length) return { ok: false, reason: 'INVALID' };
    floors = [];
    const levels = new Set<number>();
    const seen = new Set<string>();
    for (const raw of root.floors) {
      const floor = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as { level?: unknown; areas?: unknown } : null;
      if (!floor || Object.keys(floor).sort().join(',') !== 'areas,level' || !isLevel(floor.level) || levels.has(floor.level) || !Array.isArray(floor.areas)) return { ok: false, reason: 'INVALID' };
      levels.add(floor.level);
      const rooms = parseFloorRooms(floor.areas, known, seen);
      if (rooms.length !== floor.areas.length) return { ok: false, reason: 'INVALID' };
      floors.push({ level: floor.level, areas: rooms });
    }
    if (!levels.has(0)) return { ok: false, reason: 'INVALID' };
  } else {
    if (hasUpperFloors(stored)) return { ok: false, reason: 'FLOORS_NEED_NEW_APP' };
    const seen = new Set<string>();
    const rooms = parseFloorRooms(root.areas, known, seen);
    if (!Array.isArray(root.areas) || rooms.length !== root.areas.length) return { ok: false, reason: 'INVALID' };
    floors = [{ level: 0, areas: rooms }];
  }
  const placed = floors.flatMap((floor) => floor.areas.map((room) => room.areaId)).sort();
  const wanted = [...areaIds].sort();
  if (placed.length !== wanted.length || placed.some((id, index) => id !== wanted[index])) return { ok: false, reason: 'INVALID' };
  return { ok: true, stored: { version: 2, floors: floors.sort((a, b) => a.level - b.level) } };
}
