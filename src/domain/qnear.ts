import type { JointHint, Pattern, PatternTeaching, PlanEvent, Pose, Recipe, RecipeTeaching, ValidationIssue, WaypointTemplate } from './model.ts';
import { orientationDistance } from './pose.ts';

type Phase = 'approach' | 'action' | 'exit';
type IdFactory = () => string;
const own = (o: object, key: string) => Object.hasOwn(o, key);
const copy = <T>(value: T): T => structuredClone(value);
const waypointKeys = ['reference', 'approach', 'action', 'exit'] as const;
const newTeaching = (): RecipeTeaching => ({ version: 1, patterns: {}, waypoints: {} });
const defaultId: IdFactory = () => crypto.randomUUID();
export function sameSourcePose(a: Pose, b: Pose): boolean {
  return a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= 1e-9) && orientationDistance(a, b) <= 1e-7;
}
function pointIndex(suffix: string, prefix: string): number | undefined {
  const s = suffix.slice(prefix.length);
  return suffix.startsWith(prefix) && /^(0|[1-9][0-9]*)$/.test(s) ? Number(s) : undefined;
}
function anchor(recipe: Recipe, key: string): { pose: Pose; pattern?: Pattern; suffix: string } | undefined {
  if (waypointKeys.includes(key as keyof WaypointTemplate)) return { pose: recipe.waypoints[key as keyof WaypointTemplate], suffix: key };
  if (key === 'separator.pose' && recipe.separator) return { pose: recipe.separator.pose, suffix: 'pose' };
  if (key.startsWith('separator.') && recipe.separator && waypointKeys.includes(key.slice(10) as keyof WaypointTemplate)) {
    return { pose: recipe.separator.waypoints[key.slice(10) as keyof WaypointTemplate], suffix: key.slice(10) };
  }
  const dot = key.lastIndexOf('.');
  const pattern = recipe.patterns.find(p => p.id === key.slice(0, dot));
  const suffix = key.slice(dot + 1);
  if (!pattern) return;
  if (pattern.kind === 'line' && (suffix === 'start' || suffix === 'end')) return { pose: pattern[suffix], pattern, suffix };
  if (pattern.kind === 'grid') {
    const i = pointIndex(suffix, 'corner');
    if (i !== undefined && i < 4) return { pose: pattern.corners[i], pattern, suffix };
  }
  if (pattern.kind === 'irregular') {
    const i = pointIndex(suffix, 'point');
    if (i !== undefined && i < pattern.poses.length) return { pose: pattern.poses[i], pattern, suffix };
  }
}
export function getJointHint(recipe: Recipe, key: string): JointHint | undefined {
  const a = anchor(recipe, key);
  const t = recipe.teaching;
  if (!a || !t) return;
  if (!a.pattern) return key.startsWith('separator.')
    ? a.suffix === 'pose' ? t.separator?.pose : t.separator?.waypoints[a.suffix as keyof WaypointTemplate]
    : t.waypoints[a.suffix as keyof WaypointTemplate];
  const p = own(t.patterns, a.pattern.id) ? t.patterns[a.pattern.id] : undefined;
  if (!p || p.kind !== a.pattern.kind) return;
  if (p.kind === 'line') return p[a.suffix as 'start' | 'end'];
  if (p.kind === 'grid') return p.corners[Number(a.suffix.slice(6))] ?? undefined;
  const id = p.pointIds[Number(a.suffix.slice(5))];
  return id && own(p.hintsById, id) ? p.hintsById[id] : undefined;
}
function freshIds(count: number, factory: IdFactory, forbidden = new Set<string>()): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = factory();
    if (typeof id !== 'string' || !id.trim() || id.length > 128 || forbidden.has(id)) throw new Error('Point ID factory must return fresh, non-empty IDs');
    forbidden.add(id); ids.push(id);
  }
  return ids;
}
function emptyPattern(p: Pattern, idFactory: IdFactory): PatternTeaching {
  if (p.kind === 'line') return { kind: 'line' };
  if (p.kind === 'grid') return { kind: 'grid', corners: [null, null, null, null] };
  return { kind: 'irregular', pointIds: freshIds(p.poses.length, idFactory), hintsById: {} };
}
/** Immutable; stores measured q only for the exact current local anchor. No revision/approval side effects. */
export function setJointHint(recipe: Recipe, key: string, hint: JointHint, idFactory: IdFactory = defaultId): Recipe {
  const a = anchor(recipe, key);
  if (!a) throw new Error(`Unknown teach anchor: ${key}`);
  const errors = validateJointHint(hint, a.pose, key);
  if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
  const out = copy(recipe);
  const t = out.teaching ??= newTeaching();
  if (!a.pattern) {
    if (key.startsWith('separator.')) {
      t.separator ??= { waypoints: {} };
      if (a.suffix === 'pose') t.separator.pose = copy(hint);
      else t.separator.waypoints[a.suffix as keyof WaypointTemplate] = copy(hint);
    } else t.waypoints[a.suffix as keyof WaypointTemplate] = copy(hint);
    return out;
  }
  const existing = own(t.patterns, a.pattern.id) ? t.patterns[a.pattern.id] : undefined;
  const p = existing?.kind === a.pattern.kind ? existing : emptyPattern(a.pattern, idFactory);
  Object.defineProperty(t.patterns, a.pattern.id, { value: p, enumerable: true, configurable: true, writable: true });
  if (p.kind === 'line') p[a.suffix as 'start' | 'end'] = copy(hint);
  else if (p.kind === 'grid') p.corners[Number(a.suffix.slice(6))] = copy(hint);
  else Object.defineProperty(p.hintsById, p.pointIds[Number(a.suffix.slice(5))], { value: copy(hint), enumerable: true, configurable: true, writable: true });
  return out;
}
export function clearJointHint(recipe: Recipe, key: string): Recipe {
  const out = copy(recipe), a = anchor(out, key), t = out.teaching;
  if (!a || !t) return out;
  if (!a.pattern) {
    if (key.startsWith('separator.')) {
      if (a.suffix === 'pose' && t.separator) delete t.separator.pose;
      else if (t.separator) delete t.separator.waypoints[a.suffix as keyof WaypointTemplate];
    } else delete t.waypoints[a.suffix as keyof WaypointTemplate];
  } else {
    const p = own(t.patterns, a.pattern.id) ? t.patterns[a.pattern.id] : undefined;
    if (p?.kind === 'line') delete p[a.suffix as 'start' | 'end'];
    else if (p?.kind === 'grid') p.corners[Number(a.suffix.slice(6))] = null;
    else if (p?.kind === 'irregular') delete p.hintsById[p.pointIds[Number(a.suffix.slice(5))]];
  }
  return out;
}
/** PS5 5.26.1 generated-script rules. Only item approach uses pattern q; all other phases use their own taught q. */
export function jointHintForEvent(recipe: Recipe, event: PlanEvent, phase: Phase): { sourceKey: string; hint?: JointHint } {
  let sourceKey: string = event.kind === 'separator' ? `separator.${phase}` : phase;
  if (event.kind === 'item' && phase === 'approach') {
    const p = recipe.patterns.find(p => p.id === event.patternId);
    if (!p) throw new Error('Event references an absent pattern');
    const count = p.kind === 'line' ? p.count : p.kind === 'grid' ? p.rows * p.columns : p.poses.length;
    if (!Number.isSafeInteger(event.itemIndex) || event.itemIndex < 0 || event.itemIndex >= count) throw new RangeError('Invalid geometric item index');
    if (p.kind === 'line') sourceKey = `${p.id}.${event.itemIndex < p.count / 2 ? 'start' : 'end'}`;
    else if (p.kind === 'irregular') sourceKey = `${p.id}.point${event.itemIndex}`;
    else {
      const xLow = event.itemIndex % p.rows < p.rows / 2;
      const yLow = Math.floor(event.itemIndex / p.rows) < p.columns / 2;
      sourceKey = `${p.id}.corner${xLow ? yLow ? 0 : 3 : yLow ? 1 : 2}`;
    }
  }
  const hint = getJointHint(recipe, sourceKey);
  const a = anchor(recipe, sourceKey);
  return { sourceKey, ...(hint && a && validateJointHint(hint, a.pose, sourceKey).length === 0 ? { hint } : {}) };
}
export const resolveJointHint = jointHintForEvent;

/** Remove geometry and stable identity together; surviving points keep their own hints. */
export function removeIrregularPoint(recipe: Recipe, patternId: string, index: number): Recipe {
  const out = copy(recipe), p = out.patterns.find(p => p.id === patternId);
  if (!p || p.kind !== 'irregular' || !Number.isSafeInteger(index) || index < 0 || index >= p.poses.length || p.poses.length === 1) throw new RangeError('Invalid point removal');
  p.poses = p.poses.filter((_, i) => i !== index);
  const t = out.teaching?.patterns[patternId];
  if (t?.kind === 'irregular') { const [id] = t.pointIds.splice(index, 1); delete t.hintsById[id]; }
  return out;
}
export function addIrregularPoint(recipe: Recipe, patternId: string, pose: Pose, idFactory: IdFactory = defaultId): Recipe {
  const out = copy(recipe), p = out.patterns.find(p => p.id === patternId);
  if (!p || p.kind !== 'irregular') throw new Error('Expected an irregular pattern');
  p.poses = [...p.poses, copy(pose)];
  const t = out.teaching?.patterns[patternId];
  if (t?.kind === 'irregular') t.pointIds.push(...freshIds(1, idFactory, new Set(t.pointIds)));
  return out;
}
export function moveIrregularPoint(recipe: Recipe, patternId: string, from: number, to: number): Recipe {
  const out = copy(recipe), p = out.patterns.find(p => p.id === patternId);
  if (!p || p.kind !== 'irregular' || ![from, to].every(i => Number.isSafeInteger(i) && i >= 0 && i < p.poses.length)) throw new RangeError('Invalid point move');
  const poses = [...p.poses]; const [pose] = poses.splice(from, 1); poses.splice(to, 0, pose); p.poses = poses;
  const t = out.teaching?.patterns[patternId];
  if (t?.kind === 'irregular') { const [id] = t.pointIds.splice(from, 1); t.pointIds.splice(to, 0, id); }
  return out;
}
export function removePatternHints(recipe: Recipe, patternId: string): Recipe {
  const out = copy(recipe); if (out.teaching) delete out.teaching.patterns[patternId]; return out;
}
/** Destination pattern already exists as a geometry copy; fresh free-point IDs prevent aliases. */
export function duplicatePatternHints(recipe: Recipe, sourceId: string, destinationId: string, idFactory: IdFactory = defaultId): Recipe {
  const out = copy(recipe), source = out.teaching?.patterns[sourceId];
  if (!source) return out;
  if (sourceId === destinationId || !out.patterns.some(p => p.id === destinationId && p.kind === source.kind)) throw new Error('Expected a new destination pattern');
  const t = copy(source);
  if (t.kind === 'irregular') {
    const old = t.pointIds; t.pointIds = freshIds(old.length, idFactory, new Set(old));
    t.hintsById = Object.fromEntries(old.flatMap((id, i) => own(t.hintsById, id) ? [[t.pointIds[i], t.hintsById[id]]] : []));
  }
  Object.defineProperty(out.teaching!.patterns, destinationId, { value: t, enumerable: true, configurable: true, writable: true });
  return reconcileTeaching(recipe, out);
}
/** Geometry/pattern IDs have already been remapped by the importer; this remaps metadata only. */
export function remapTeachingForImport(recipe: Recipe, patternIds: Readonly<Record<string, string>>, idFactory: IdFactory = defaultId): Recipe {
  const out = copy(recipe); if (!out.teaching) return out;
  const entries: [string, PatternTeaching][] = [];
  for (const [oldId, t] of Object.entries(out.teaching.patterns)) {
    const newId = own(patternIds, oldId) ? patternIds[oldId] : undefined;
    if (!newId || entries.some(([id]) => id === newId)) throw new Error('Incomplete or duplicate teaching ID mapping');
    if (t.kind === 'irregular') {
      const old = t.pointIds; t.pointIds = freshIds(old.length, idFactory, new Set(old));
      t.hintsById = Object.fromEntries(old.flatMap((id, i) => own(t.hintsById, id) ? [[t.pointIds[i], t.hintsById[id]]] : []));
    }
    entries.push([newId, t]);
  }
  out.teaching.patterns = Object.fromEntries(entries);
  return reconcileTeaching(recipe, out);
}
/** Drop only hints whose local anchor changed. Array insertion/removal/reordering must use the paired helpers above. */
export function reconcileTeaching(_before: Recipe, after: Recipe): Recipe {
  let out = copy(after); const t = out.teaching; if (!t) return out;
  for (const [id, hint] of Object.entries(t.patterns)) {
    const p = out.patterns.find(p => p.id === id);
    if (!p || p.kind !== hint.kind || (p.kind === 'irregular' && hint.kind === 'irregular' && p.poses.length !== hint.pointIds.length)) { delete t.patterns[id]; continue; }
  }
  if (!out.separator) delete t.separator;
  for (const key of jointHintKeys(out)) {
    const hint = getJointHint(out, key), a = anchor(out, key);
    if (hint && (!a || !sameSourcePose(hint.sourcePose, a.pose))) out = clearJointHint(out, key);
  }
  return out;
}
export function jointHintKeys(recipe: Recipe): string[] {
  return [...waypointKeys, ...(recipe.separator ? ['separator.pose', ...waypointKeys.map(k => `separator.${k}`)] : []), ...recipe.patterns.flatMap(p => p.kind === 'line'
    ? [`${p.id}.start`, `${p.id}.end`] : p.kind === 'grid' ? p.corners.map((_, i) => `${p.id}.corner${i}`) : p.poses.map((_, i) => `${p.id}.point${i}`))];
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sixFinite = (v: unknown): v is Pose => Array.isArray(v) && v.length === 6 && Array.from({ length: 6 }, (_, i) => i).every(i => typeof v[i] === 'number' && Number.isFinite(v[i]) && Math.abs(v[i]) <= 1_000_000);
function validateJointHint(hint: unknown, source: Pose, path: string): ValidationIssue[] {
  const errors: ValidationIssue[] = [], fail = (message: string) => errors.push({ path, code: 'joint-hint', message });
  if (!record(hint)) { fail('Expected a measured joint hint'); return errors; }
  if (!sixFinite(hint.q)) fail('Expected six finite joint angles with preserved winding');
  if (!sixFinite(hint.sourcePose) || !sameSourcePose(hint.sourcePose, source)) fail('Joint hint source pose does not match its current local anchor');
  if (!sixFinite(hint.featurePoseAtTeach)) fail('Expected the feature pose measured at teaching');
  if (typeof hint.robotType !== 'string' || !hint.robotType.trim() || hint.robotType.length > 128) fail('Expected the teaching robot type');
  if (hint.acquisition !== 'move-screen') fail('Expected move-screen acquisition provenance');
  if (hint.tcp !== undefined && (!record(hint.tcp) || typeof hint.tcp.id !== 'string' || !hint.tcp.id.trim() || hint.tcp.id.length > 128 || typeof hint.tcp.name !== 'string' || hint.tcp.name.length > 160)) fail('Invalid TCP metadata');
  return errors;
}
/** Call after base recipe validation succeeds, before using optional untrusted metadata. */
export function validateTeaching(recipe: Recipe): ValidationIssue[] {
  const input: unknown = recipe.teaching;
  if (input === undefined) return [];
  const errors: ValidationIssue[] = [], fail = (path: string, message: string) => errors.push({ path, code: 'teaching', message });
  if (!record(input) || input.version !== 1 || !record(input.patterns) || !record(input.waypoints)) { fail('teaching', 'Expected teaching version1, patterns and waypoints maps'); return errors; }
  if (Object.keys(input.patterns).length > recipe.patterns.length) { fail('teaching.patterns', 'Hint map exceeds the number of recipe patterns'); return errors; }
  const hints = (values: Record<string, unknown>, poses: WaypointTemplate, path: string) => {
    if (Object.keys(values).length > waypointKeys.length) { fail(path, 'Waypoint hint map exceeds four anchors'); return; }
    for (const [key, value] of Object.entries(values)) {
      if (!waypointKeys.includes(key as keyof WaypointTemplate)) fail(`${path}.${key}`, 'Unknown waypoint hint');
      else errors.push(...validateJointHint(value, poses[key as keyof WaypointTemplate], `${path}.${key}`));
    }
  };
  hints(input.waypoints, recipe.waypoints, 'teaching.waypoints');
  if (input.separator !== undefined) {
    if (!recipe.separator || !record(input.separator) || !record(input.separator.waypoints)) fail('teaching.separator', 'Separator hints require a separator and waypoints map');
    else {
      if (input.separator.pose !== undefined) errors.push(...validateJointHint(input.separator.pose, recipe.separator.pose, 'teaching.separator.pose'));
      hints(input.separator.waypoints, recipe.separator.waypoints, 'teaching.separator.waypoints');
    }
  }
  const patterns = new Map(recipe.patterns.map(p => [p.id, p]));
  for (const [id, t] of Object.entries(input.patterns)) {
    const path = `teaching.patterns.${id}`, p = patterns.get(id);
    if (!p || !record(t) || t.kind !== p.kind) { fail(path, 'Hint pattern is absent or has a different type'); continue; }
    if (p.kind === 'line') for (const key of ['start', 'end'] as const) { if (t[key] !== undefined) errors.push(...validateJointHint(t[key], p[key], `${path}.${key}`)); }
    else if (p.kind === 'grid') {
      if (!Array.isArray(t.corners) || t.corners.length !== 4 || ![0, 1, 2, 3].every(i => i in (t.corners as unknown[]))) fail(path, 'Expected four optional corner hints (null for missing)');
      else t.corners.forEach((h, i) => { if (h !== null) errors.push(...validateJointHint(h, p.corners[i], `${path}.corners[${i}]`)); });
    } else {
      const ids = t.pointIds;
      if (!Array.isArray(ids) || ids.length !== p.poses.length || !Array.from({ length: ids.length }, (_, i) => i).every(i => typeof ids[i] === 'string' && ids[i].trim() && ids[i].length <= 128) || new Set(ids).size !== ids.length || !record(t.hintsById)) { fail(path, 'Expected unique point IDs aligned to poses and a hint map'); continue; }
      if (Object.keys(t.hintsById).length > ids.length) { fail(path, 'Hint map exceeds the number of free points'); continue; }
      for (const [pointId, h] of Object.entries(t.hintsById)) {
        const i = ids.indexOf(pointId);
        if (i < 0) fail(`${path}.hintsById.${pointId}`, 'Orphaned free-point hint');
        else errors.push(...validateJointHint(h, p.poses[i], `${path}.hintsById.${pointId}`));
      }
    }
  }
  return errors;
}
