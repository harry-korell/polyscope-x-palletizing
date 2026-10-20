import { clearJointHint, orientationDistance, patternPoseAt, reconcileTeaching, translatePose } from '../../src/domain/index.ts';
import type { GridPattern, Pattern, Pose } from '../../src/domain/index.ts';
import type { MotionSettings, PalletNode } from './model.ts';

/** Explicit construction choices; absence preserves every legacy recipe value. */
export interface SetupMetadata {
  version: 1;
  rectangles: Record<string, { kind: 'axis-aligned'; review?: string }>;
  vertical?: { kind: 'vertical'; patternId: string; clearance: number; review?: string };
}
export type SetupNode = PalletNode;
export interface SetupSyncResult<T extends PalletNode = PalletNode> { node: T; errors: string[]; geometryChanged: boolean; }
const copy = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finitePose = (p: Pose) => Array.isArray(p) && p.length === 6 && [0, 1, 2, 3, 4, 5].every(i => typeof p[i] === 'number' && Number.isFinite(p[i]) && Math.abs(p[i]) <= 1000);
const phases = ['approach', 'action', 'exit'] as const;

/** Change detector, not an authentication or robot-safety checksum. */
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value); let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) { hash ^= BigInt(text.charCodeAt(i)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return `setup-v1-${hash.toString(16).padStart(16, '0')}`;
}
function metadataErrors(input: unknown): string[] {
  if (input === undefined) return [];
  if (!record(input) || input.version !== 1 || !record(input.rectangles)) return ['Einrichtungsmodus ist ungültig. Erweiterte Einrichtung verwenden.'];
  const errors: string[] = [];
  for (const [id, value] of Object.entries(input.rectangles)) if (!id || !record(value) || value.kind !== 'axis-aligned' || (value.review !== undefined && (typeof value.review !== 'string' || value.review.length > 128))) errors.push('Rechteck-Einrichtung ist ungültig.');
  if (input.vertical !== undefined) {
    const v = input.vertical;
    if (!record(v) || v.kind !== 'vertical' || typeof v.patternId !== 'string' || !v.patternId || typeof v.clearance !== 'number' || !Number.isFinite(v.clearance) || v.clearance <= 0 || v.clearance > 1000 || (v.review !== undefined && (typeof v.review !== 'string' || v.review.length > 128))) errors.push('An-/Ausfahrabstand muss eine endliche positive Länge sein.');
  }
  return errors;
}
function metadata(node: PalletNode): SetupMetadata {
  const errors = metadataErrors(node.parameters.setup); if (errors.length) throw new Error(errors.join(' '));
  return node.parameters.setup ??= { version: 1, rectangles: {} };
}
function grid(node: PalletNode, patternId: string): GridPattern {
  const p = node.parameters.recipe.patterns.find(p => p.id === patternId);
  if (!p || p.kind !== 'grid') throw new Error('Rechteck benötigt ein vorhandenes Rastermuster.');
  return p;
}
function frameContext(node: PalletNode) { return [node.parameters.featureFrame ?? null, node.parameters.recipe.featurePose]; }
function patternGeometry(p: Pattern): unknown {
  return p.kind === 'grid' ? [p.id, p.kind, p.rows, p.columns, p.corners] : p.kind === 'line' ? [p.id, p.kind, p.count, p.start, p.end] : [p.id, p.kind, p.poses];
}
function patternKeys(p: Pattern): string[] {
  return p.kind === 'grid' ? p.corners.map((_, i) => `${p.id}.corner${i}`) : p.kind === 'line' ? [`${p.id}.start`, `${p.id}.end`] : p.poses.map((_, i) => `${p.id}.point${i}`);
}
function rectangleSignature(node: PalletNode, p: GridPattern) { return fingerprint(['rectangle', frameContext(node), p.id, p.rows, p.columns, p.corners[0], p.corners[2]]); }
function rectangleSourcesConfirmed(node: PalletNode, p: GridPattern) { return node.parameters.taught.feature === true && node.parameters.taught[`${p.id}.corner0`] === true && node.parameters.taught[`${p.id}.corner2`] === true; }
function verticalSourcesConfirmed(node: PalletNode) { return node.parameters.taught.feature === true && node.parameters.recipe.patterns.flatMap(patternKeys).every(key => node.parameters.taught[key] === true); }
function profileGeometry(motion: MotionSettings | undefined) { return motion ? ['item', 'separator'].map(kind => phases.map(phase => { const p = motion[kind as keyof MotionSettings]?.[phase]; return p ? [p.type, p.speed, p.acceleration, p.blend, p.qNearMode ?? null] : null; })) : null; }
function waypointGeometry(node: PalletNode) { const w = node.parameters.recipe.waypoints; return [w.reference, w.approach, w.action, w.exit]; }
function verticalSignature(node: PalletNode): string {
  const r = node.parameters.recipe, v = node.parameters.setup!.vertical!;
  return fingerprint(['vertical', frameContext(node), v.patternId, v.clearance, r.mode, r.patterns.map(patternGeometry), r.layers.map(l => [l.id, l.patternId, l.separatorAfter]), r.objectHeight, r.separator?.height ?? null, r.orientationPolicy ?? 'ps5-reference-relative', waypointGeometry(node), profileGeometry(node.parameters.motion)?.[0]]);
}
function executionGeometry(node: PalletNode) {
  const r = node.parameters.recipe, selection = node.parameters.referenceSelection;
  return [r.patterns.map(patternGeometry), waypointGeometry(node), r.orientationPolicy ?? 'ps5-reference-relative', profileGeometry(node.parameters.motion), selection ? [selection.patternId, selection.itemIndex] : null, r.teaching];
}

/** Preserve measured C1/C3 verbatim; only C2/C4 are constructed with C1 Z/orientation. */
export function rectangleCorners(first: Pose, opposite: Pose): GridPattern['corners'] {
  if (!finitePose(first) || !finitePose(opposite)) throw new Error('Beide Rechteckecken müssen gültige Positionen sein.');
  if (Math.abs(first[2] - opposite[2]) > 0.0001 + 1e-12) throw new Error('Beide Ecken auf gleicher Höhe einlernen (höchstens 0,1 mm Abweichung).');
  if (orientationDistance(first, opposite) > 0.001 + 1e-12) throw new Error('Beide Ecken mit gleicher Werkzeugorientierung einlernen (höchstens 0,001 rad Abweichung).');
  return [[...first], [opposite[0], first[1], first[2], first[3], first[4], first[5]], [...opposite], [first[0], opposite[1], first[2], first[3], first[4], first[5]]];
}
function constructedCorners(p: GridPattern) {
  const corners = rectangleCorners(p.corners[0], p.corners[2]);
  if (!Number.isSafeInteger(p.rows) || p.rows < 1 || !Number.isSafeInteger(p.columns) || p.columns < 1) throw new Error('Zeilen und Spalten müssen positive ganze Zahlen sein.');
  if (p.rows > 1 && Math.abs(corners[1][0] - corners[0][0]) <= 1e-9) throw new Error('Für mehrere Zeilen müssen die Ecken unterschiedliche X-Werte haben.');
  if (p.columns > 1 && Math.abs(corners[3][1] - corners[0][1]) <= 1e-9) throw new Error('Für mehrere Spalten müssen die Ecken unterschiedliche Y-Werte haben.');
  return corners;
}
function profiles(node: PalletNode): MotionSettings {
  if (node.parameters.motion) return copy(node.parameters.motion);
  const p = node.parameters, profile = () => ({ type: 'linear' as const, speed: p.speed, acceleration: p.acceleration, blend: 0 });
  const set = () => ({ approach: profile(), action: profile(), exit: profile() });
  const result = { item: set(), separator: set() }; result.item.approach.blend = p.blend; result.separator.approach.blend = p.blend; return result;
}

/** Run after generic reference invalidation. Does not change revision or recipe approval. */
export function synchronizeSetup<T extends PalletNode>(input: T): SetupSyncResult<T> {
  const node = copy(input), shapeErrors = metadataErrors(node.parameters.setup);
  if (!node.parameters.setup || shapeErrors.length) return { node, errors: shapeErrors, geometryChanged: false };
  const before = copy(node.parameters.recipe), previousGeometry = executionGeometry(copy(node)), setup = node.parameters.setup, errors: string[] = [];
  for (const [patternId, choice] of Object.entries(setup.rectangles)) {
    try {
      const p = grid(node, patternId), corners = constructedCorners(p);
      const changed = !same(p.corners, corners); if (changed) { p.corners = corners; delete choice.review; }
      const reviewed = rectangleSourcesConfirmed(node, p) && choice.review === rectangleSignature(node, p);
      if (!reviewed) delete choice.review;
      for (const i of [1, 3]) node.parameters.taught[`${p.id}.corner${i}`] = reviewed;
      if (!reviewed) errors.push(`Rechteck „${p.name}“: beide Ecken einlernen und abgeleitete Ecken prüfen.`);
    } catch (error) {
      delete choice.review;
      for (const i of [1, 3]) node.parameters.taught[`${patternId}.corner${i}`] = false;
      errors.push(String(error instanceof Error ? error.message : error));
    }
  }
  if (setup.vertical) {
    const choice = setup.vertical;
    try {
      const p = node.parameters.recipe.patterns.find(p => p.id === choice.patternId);
      if (!p) throw new Error('Referenzmuster für einfachen Ablauf fehlt.');
      const reference = patternPoseAt(p, 0), raised = translatePose(reference, [0, 0, choice.clearance]);
      if (!finitePose(reference) || !finitePose(raised)) throw new Error('Abgeleitete An-/Ausfahrt enthält ungültige Positionswerte.');
      const r = node.parameters.recipe, desired = { reference: [...reference] as Pose, action: [...reference] as Pose, approach: raised, exit: [...raised] as Pose };
      const motion = profiles(node);
      for (const phase of phases) {
        const old = motion.item[phase]; motion.item[phase] = { type: 'linear', speed: old.type === 'linear' ? old.speed : 0.1, acceleration: old.type === 'linear' ? old.acceleration : 0.25, blend: 0 };
      }
      const selection = { patternId: p.id, itemIndex: 0 };
      const selectionMatches = node.parameters.referenceSelection?.patternId === p.id && node.parameters.referenceSelection.itemIndex === 0;
      if (!same(waypointGeometry(node), [desired.reference, desired.approach, desired.action, desired.exit]) || !selectionMatches || !same(profileGeometry(node.parameters.motion), profileGeometry(motion)) || (r.orientationPolicy ?? 'ps5-reference-relative') !== 'ps5-reference-relative') delete choice.review;
      r.waypoints = desired; r.orientationPolicy = 'ps5-reference-relative'; node.parameters.referenceSelection = selection; node.parameters.motion = motion;
      const reviewed = verticalSourcesConfirmed(node) && choice.review === verticalSignature(node);
      if (!reviewed) delete choice.review;
      node.parameters.taught.reference = verticalSourcesConfirmed(node);
      for (const phase of phases) node.parameters.taught[phase] = reviewed;
      if (!reviewed) errors.push('Einfachen Ablauf und An-/Ausfahrabstand bewusst prüfen.');
    } catch (error) {
      delete choice.review; node.parameters.taught.reference = false;
      for (const phase of phases) node.parameters.taught[phase] = false;
      errors.push(String(error instanceof Error ? error.message : error));
    }
  }
  node.parameters.recipe = reconcileTeaching(before, node.parameters.recipe);
  // Reference changes also invalidate exact-pose hints when their template relationship changed.
  if (!same(before.waypoints.reference, node.parameters.recipe.waypoints.reference)) for (const phase of phases) node.parameters.recipe = clearJointHint(node.parameters.recipe, phase);
  return { node, errors, geometryChanged: !same(previousGeometry, executionGeometry(node)) };
}
export function setupErrors(node: PalletNode): string[] { return synchronizeSetup(node).errors; }
export function setRectangleSetup<T extends PalletNode>(input: T, patternId: string, enabled = true): T {
  const node = copy(input), setup = metadata(node); grid(node, patternId);
  if (enabled) setup.rectangles[patternId] = { kind: 'axis-aligned' }; else delete setup.rectangles[patternId];
  return synchronizeSetup(node).node;
}
export function setVerticalSetup<T extends PalletNode>(input: T, patternId: string, clearance: number): T {
  if (!Number.isFinite(clearance) || clearance <= 0 || clearance > 1000) throw new Error('An-/Ausfahrabstand muss eine endliche positive Länge sein.');
  if (!input.parameters.recipe.patterns.some(p => p.id === patternId)) throw new Error('Referenzmuster fehlt.');
  const node = copy(input); metadata(node).vertical = { kind: 'vertical', patternId, clearance }; return synchronizeSetup(node).node;
}
export function clearVerticalSetup<T extends PalletNode>(input: T): T { const node = copy(input); if (node.parameters.setup) delete metadata(node).vertical; return node; }
export function reviewRectangleSetup<T extends PalletNode>(input: T, patternId: string): T {
  const node = synchronizeSetup(input).node, p = grid(node, patternId), choice = node.parameters.setup?.rectangles[patternId];
  if (!choice) throw new Error('Rechteck-Einrichtung zuerst ausdrücklich wählen.');
  constructedCorners(p);
  if (!rectangleSourcesConfirmed(node, p)) throw new Error('Palettenbezug und beide gemessenen Ecken zuerst einlernen oder prüfen.');
  choice.review = rectangleSignature(node, p);
  for (const i of [1, 3]) node.parameters.taught[`${p.id}.corner${i}`] = true;
  return node;
}
export function reviewVerticalSetup<T extends PalletNode>(input: T): T {
  const synchronized = synchronizeSetup(input), node = synchronized.node, choice = node.parameters.setup?.vertical;
  if (!choice) throw new Error('Einfachen Ablauf zuerst ausdrücklich wählen.');
  if (!verticalSourcesConfirmed(node) || synchronized.errors.some(error => !error.startsWith('Einfachen Ablauf'))) throw new Error('Palettenbezug und Musterpositionen zuerst einlernen oder prüfen.');
  choice.review = verticalSignature(node);
  node.parameters.taught.reference = true; for (const phase of phases) node.parameters.taught[phase] = true;
  return node;
}
