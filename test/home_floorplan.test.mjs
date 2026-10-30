import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync('src/lib/homeFloorplan.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const isolated = { exports: {} };
new Function('module', 'exports', 'require', compiled)(isolated, isolated.exports, require);
const { starterFloorplan, completeFloorplan, completeFloors, legacyAreas, floorplanDocument, hasUpperFloors, submittedFloorplan, FLOOR_LEVELS, FLOORPLAN_COLUMNS, FLOORPLAN_ROWS } = isolated.exports;

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const valid = (rooms) => rooms.every((r, i) => Number.isInteger(r.x) && Number.isInteger(r.y) && r.x >= 0 && r.y >= 0 && r.width >= 1 && r.height >= 1
  && r.x + r.width <= FLOORPLAN_COLUMNS && r.y + r.height <= FLOORPLAN_ROWS && rooms.every((o, j) => j <= i || !overlaps(r, o)));
function sharedWall(a, b) {
  if (overlaps(a, b)) return 0;
  const span = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  if (a.x + a.width === b.x || b.x + b.width === a.x) return span(a.y, a.y + a.height, b.y, b.y + b.height);
  if (a.y + a.height === b.y || b.y + b.height === a.y) return span(a.x, a.x + a.width, b.x, b.x + b.width);
  return 0;
}
const attached = (rooms) => rooms.length < 2 || rooms.every((r) => rooms.some((o) => o !== r && sharedWall(r, o) >= 1));
const ids = (n) => Array.from({ length: n }, (_, i) => `area-${i}`);

test('the starter layout is valid, joined, and keeps every room for 1 to 64 rooms', () => {
  for (let n = 1; n <= 64; n += 1) {
    const rooms = starterFloorplan(ids(n));
    assert.deepEqual(rooms.map((r) => r.areaId), ids(n));
    assert.ok(valid(rooms), `${n} rooms are valid`);
    assert.ok(attached(rooms), `${n} rooms share walls`);
  }
  assert.deepEqual(starterFloorplan([]), []);
});

test('a saved plan is kept exactly as saved', () => {
  const saved = { version: 1, areas: [
    { areaId: 'area-0', x: 2, y: 3, width: 10, height: 9 },
    { areaId: 'area-1', x: 12, y: 3, width: 8, height: 9 },
  ] };
  assert.deepEqual(completeFloorplan(['area-0', 'area-1'], saved), saved.areas);
});

test('rooms added since the plan was saved are placed beside it without moving anything', () => {
  const saved = { version: 1, areas: [
    { areaId: 'area-0', x: 0, y: 0, width: 16, height: 14 },
    { areaId: 'area-1', x: 16, y: 0, width: 16, height: 14 },
  ] };
  const result = completeFloorplan(ids(5), saved);
  assert.deepEqual(result.slice(0, 2), saved.areas, 'existing rooms keep their place');
  assert.deepEqual(result.map((r) => r.areaId).sort(), ids(5).sort());
  assert.ok(valid(result));
  assert.ok(attached(result), 'new rooms share a wall with the plan');
});

test('rooms that were removed are dropped and the rest stay', () => {
  const saved = { version: 1, areas: [
    { areaId: 'area-0', x: 0, y: 0, width: 16, height: 14 },
    { areaId: 'gone', x: 16, y: 0, width: 16, height: 14 },
    { areaId: 'area-1', x: 0, y: 14, width: 16, height: 14 },
  ] };
  assert.deepEqual(completeFloorplan(['area-0', 'area-1'], saved), [saved.areas[0], saved.areas[2]]);
});

test('invalid saved rooms are replaced individually, not the whole plan', () => {
  const saved = { version: 1, areas: [
    { areaId: 'area-0', x: 0, y: 0, width: 16, height: 14 },
    { areaId: 'area-1', x: 8, y: 0, width: 16, height: 14 },          // overlaps area-0
    { areaId: 'area-2', x: 40.5, y: 0, width: 4, height: 4 },         // not whole cells
    { areaId: 'area-3', x: 44, y: 60, width: 9, height: 9 },          // outside the plan
  ] };
  const result = completeFloorplan(ids(4), saved);
  assert.deepEqual(result[0], saved.areas[0]);
  assert.equal(result.length, 4);
  assert.ok(valid(result));
});

test('the old percentage-scale plan the claim flow used to write falls back to a valid starter plan', () => {
  const legacy = { version: 1, areas: ids(5).map((areaId, i) => ({ areaId, x: (i % 3) * 100 / 3, y: Math.floor(i / 3) * 50, width: 100 / 3, height: 50 })) };
  const result = completeFloorplan(ids(5), legacy);
  assert.ok(valid(result));
  assert.equal(result.length, 5);
});

test('no document, a malformed document, or an empty one gives the starter layout', () => {
  for (const document of [null, undefined, 'x', [], { version: 2, areas: [] }, { version: 1 }, { version: 1, areas: [] }]) {
    assert.deepEqual(completeFloorplan(ids(3), document), starterFloorplan(ids(3)));
  }
});

test('a full plan still places a new room instead of losing it', () => {
  const full = { version: 1, areas: [{ areaId: 'area-0', x: 0, y: 0, width: 48, height: 64 }] };
  const result = completeFloorplan(['area-0', 'area-1'], full);
  assert.equal(result.length, 2);
  assert.ok(valid(result), 'never overlaps');
  assert.deepEqual(result.map((r) => r.areaId).sort(), ['area-0', 'area-1']);
});

const room = (areaId, x, y, width = 8, height = 8) => ({ areaId, x, y, width, height });

test('a plan saved before floors is the Ground floor, and older apps see the same rooms', () => {
  const saved = { version: 1, areas: [room('area-0', 2, 3), room('area-1', 10, 3)] };
  const floors = completeFloors(ids(2), saved);
  assert.deepEqual(floors, [{ level: 0, areas: saved.areas }]);
  const document = floorplanDocument(ids(2), saved);
  assert.equal(document.version, 1);
  assert.deepEqual(document.areas, saved.areas);
  assert.deepEqual(document.floors, floors);
});

test('floors keep each room on its own floor and rooms added later go to the Ground floor', () => {
  const stored = { version: 2, floors: [{ level: 0, areas: [room('area-0', 0, 0)] }, { level: 2, areas: [room('area-1', 4, 4)] }] };
  const floors = completeFloors(ids(3), stored);
  assert.deepEqual(floors.map((floor) => floor.level), [0, 2]);
  assert.deepEqual(floors[1].areas, [room('area-1', 4, 4)]);
  assert.deepEqual(floors[0].areas.map((r) => r.areaId).sort(), ['area-0', 'area-2']);
  assert.ok(valid(floors[0].areas));
});

test('removed rooms disappear from every floor, and a room saved on two floors counts once', () => {
  const stored = { version: 2, floors: [{ level: 0, areas: [room('area-0', 0, 0), room('gone', 10, 0)] }, { level: 1, areas: [room('area-0', 0, 0), room('area-1', 0, 0)] }] };
  const floors = completeFloors(['area-0', 'area-1'], stored);
  assert.deepEqual(floors.find((floor) => floor.level === 0).areas.map((r) => r.areaId), ['area-0']);
  assert.deepEqual(floors.find((floor) => floor.level === 1).areas.map((r) => r.areaId), ['area-1']);
});

test('an unusable or missing plan starts as the starter layout on the Ground floor', () => {
  for (const stored of [null, {}, { version: 3 }, { version: 2, floors: 'x' }]) {
    const floors = completeFloors(ids(4), stored);
    assert.equal(floors.length, 1);
    assert.equal(floors[0].level, 0);
    assert.deepEqual(floors[0].areas, starterFloorplan(ids(4)));
  }
  assert.deepEqual(completeFloors([], null), [{ level: 0, areas: [] }]);
});

test('the view for older apps has every room once without overlaps', () => {
  const floors = [{ level: 0, areas: [room('a', 0, 0, 10, 10)] }, { level: 1, areas: [room('b', 0, 0, 10, 10), room('c', 10, 0, 10, 10)] }, { level: -1, areas: [room('d', 0, 0, 6, 6)] }];
  const flat = legacyAreas(floors);
  assert.deepEqual(flat.map((r) => r.areaId).sort(), ['a', 'b', 'c', 'd']);
  assert.ok(valid(flat));
  assert.deepEqual(flat.find((r) => r.areaId === 'a'), room('a', 0, 0, 10, 10));
});

test('submitted plans: floors form, older form, and every refusal', () => {
  const areaIds = ['a', 'b'];
  const ok = submittedFloorplan(areaIds, { version: 1, floors: [{ level: 0, areas: [room('a', 0, 0)] }, { level: 1, areas: [room('b', 0, 0)] }] }, null);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.stored.floors.map((floor) => floor.level), [0, 1]);
  assert.equal(submittedFloorplan(areaIds, { version: 1, areas: [room('a', 0, 0), room('b', 8, 0)] }, null).ok, true);
  const bad = (body) => submittedFloorplan(areaIds, body, null);
  assert.equal(bad({ version: 1, floors: [{ level: 1, areas: [room('a', 0, 0), room('b', 8, 0)] }] }).ok, false, 'no Ground floor');
  assert.equal(bad({ version: 1, floors: [{ level: 0, areas: [room('a', 0, 0)] }, { level: 1, areas: [room('a', 0, 0), room('b', 8, 0)] }] }).ok, false, 'room on two floors');
  assert.equal(bad({ version: 1, floors: [{ level: 0, areas: [room('a', 0, 0), room('b', 4, 4)] }] }).ok, false, 'overlap on a floor');
  assert.equal(bad({ version: 1, floors: [{ level: 0, areas: [room('a', 0, 0)] }] }).ok, false, 'a room missing');
  assert.equal(bad({ version: 1, floors: [{ level: 0, areas: [room('a', 0, 0), room('b', 8, 0), room('c', 20, 0)] }] }).ok, false, 'unknown room');
  assert.equal(bad({ version: 1, floors: [{ level: 0, areas: [room('a', 0, 0), room('b', 8, 0)] }, { level: 6, areas: [] }] }).ok, false, 'level out of range');
  assert.equal(bad({ version: 1, floors: [{ level: 0, areas: [room('a', 0, 0), room('b', 8, 0)] }, { level: 0, areas: [] }] }).ok, false, 'level twice');
  assert.equal(bad({ version: 1, floors: [{ level: 0, areas: [room('a', 0, 0), room('b', 8, 0)], extra: 1 }] }).ok, false, 'extra key');
  assert.equal(bad({ version: 2, areas: [] }).ok, false);
  assert.equal(bad(null).ok, false);
  assert.deepEqual(FLOOR_LEVELS, [-1, 0, 1, 2, 3, 4, 5]);
});

test('an older app may not overwrite a plan that has rooms on other floors', () => {
  const stored = { version: 2, floors: [{ level: 0, areas: [room('a', 0, 0)] }, { level: 1, areas: [room('b', 0, 0)] }] };
  assert.equal(hasUpperFloors(stored), true);
  assert.deepEqual(submittedFloorplan(['a', 'b'], { version: 1, areas: [room('a', 0, 0), room('b', 8, 0)] }, stored), { ok: false, reason: 'FLOORS_NEED_NEW_APP' });
  const emptyUpper = { version: 2, floors: [{ level: 0, areas: [room('a', 0, 0), room('b', 8, 0)] }, { level: 1, areas: [] }] };
  assert.equal(hasUpperFloors(emptyUpper), false);
  assert.equal(submittedFloorplan(['a', 'b'], { version: 1, areas: [room('a', 0, 0), room('b', 8, 0)] }, emptyUpper).ok, true);
});
