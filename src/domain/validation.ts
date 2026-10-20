import { MAX_PLAN_EVENTS } from './model.ts';
import type { Recipe, ValidationIssue } from './model.ts';
import { validateTeaching } from './qnear.ts';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function dense(value: unknown[]): boolean {
  for (let i = 0; i < value.length; i++) if (!(i in value)) return false;
  return true;
}

/** Validates untrusted JSON before allocating a plan. Bounds are computational, not reachability limits. */
export function validateRecipe(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (path: string, code: string, message: string) => issues.push({ path, code, message });
  const text = (v: unknown, path: string, limit = 128): v is string => {
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > limit) {
      issue(path, 'string', `Expected a non-empty string of at most ${limit} characters`);
      return false;
    }
    return true;
  };
  const integer = (v: unknown, path: string, min = 1, max = MAX_PLAN_EVENTS): v is number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
      issue(path, 'integer', `Expected an integer from ${min} to ${max}`);
      return false;
    }
    return true;
  };
  const positiveLength = (v: unknown, path: string): v is number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1000) {
      issue(path, 'length', 'Expected a finite positive length of at most 1000 metres');
      return false;
    }
    return true;
  };
  const pose = (v: unknown, path: string) => {
    if (!Array.isArray(v) || v.length !== 6 || !dense(v) || v.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1000)) {
      issue(path, 'pose', 'Expected six finite pose components, each with absolute value at most 1000 (m/rad)');
    }
  };
  const waypoints = (v: unknown, path: string) => {
    if (!record(v)) { issue(path, 'waypoints', 'Expected a waypoint template'); return; }
    for (const key of ['reference', 'approach', 'action', 'exit']) pose(v[key], `${path}.${key}`);
  };
  const array = (v: unknown, path: string): v is unknown[] => {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PLAN_EVENTS || !dense(v)) {
      issue(path, 'array', `Expected 1 to ${MAX_PLAN_EVENTS} entries`);
      return false;
    }
    return true;
  };
  if (!record(input)) return [{ path: '', code: 'recipe', message: 'Expected a recipe object' }];
  if (input.schemaVersion !== 1) issue('schemaVersion', 'version', 'Unsupported recipe schema; expected 1');
  if (input.plannerVersion !== undefined && input.plannerVersion !== 3) issue('plannerVersion', 'version', 'Unsupported planner version; expected 3 or legacy absence');
  text(input.id, 'id');
  text(input.name, 'name', 160);
  integer(input.revision, 'revision', 1, Number.MAX_SAFE_INTEGER);
  if (input.mode !== 'palletize' && input.mode !== 'depalletize') issue('mode', 'mode', 'Expected palletize or depalletize');
  if (typeof input.rememberProgress !== 'boolean') issue('rememberProgress', 'boolean', 'Expected a boolean');
  if (input.orientationPolicy !== undefined && input.orientationPolicy !== 'ps5-reference-relative' && input.orientationPolicy !== 'fixed-feature') {
    issue('orientationPolicy', 'orientation-policy', 'Expected ps5-reference-relative or fixed-feature');
  }
  pose(input.featurePose, 'featurePose');
  positiveLength(input.objectHeight, 'objectHeight');
  waypoints(input.waypoints, 'waypoints');

  const patternCounts = new Map<string, number>();
  const patternIds = new Set<string>();
  let taughtPoseCount = 0;
  if (array(input.patterns, 'patterns')) input.patterns.forEach((p, i) => {
    const path = `patterns[${i}]`;
    if (!record(p)) { issue(path, 'pattern', 'Expected a pattern'); return; }
    const validId = text(p.id, `${path}.id`);
    if (validId && patternIds.has(p.id as string)) issue(`${path}.id`, 'duplicate-id', 'Pattern IDs must be unique');
    if (validId) patternIds.add(p.id as string);
    text(p.name, `${path}.name`, 160);
    let count = 0;
    if (p.kind === 'line') {
      pose(p.start, `${path}.start`);
      pose(p.end, `${path}.end`);
      if (integer(p.count, `${path}.count`)) count = p.count;
    } else if (p.kind === 'grid') {
      if (!Array.isArray(p.corners) || p.corners.length !== 4 || !dense(p.corners)) issue(`${path}.corners`, 'corners', 'Expected four cyclic corner poses');
      else p.corners.forEach((v, j) => pose(v, `${path}.corners[${j}]`));
      const rowsValid = integer(p.rows, `${path}.rows`);
      const columnsValid = integer(p.columns, `${path}.columns`);
      if (rowsValid && columnsValid) {
        count = (p.rows as number) * (p.columns as number);
        if (count > MAX_PLAN_EVENTS) issue(path, 'plan-limit', `A grid may contain at most ${MAX_PLAN_EVENTS} items`);
      }
    } else if (p.kind === 'irregular') {
      if (array(p.poses, `${path}.poses`)) {
        count = p.poses.length;
        taughtPoseCount += count;
        if (taughtPoseCount <= MAX_PLAN_EVENTS) p.poses.forEach((v, j) => pose(v, `${path}.poses[${j}]`));
      }
    } else issue(`${path}.kind`, 'kind', 'Expected line, grid, or irregular');
    if (validId) patternCounts.set(p.id as string, count);
  });
  if (taughtPoseCount > MAX_PLAN_EVENTS) issue('patterns', 'geometry-limit', `At most ${MAX_PLAN_EVENTS} irregular taught poses are supported across all patterns`);

  if (input.separator !== undefined) {
    if (!record(input.separator)) issue('separator', 'separator', 'Expected a separator configuration');
    else {
      positiveLength(input.separator.height, 'separator.height');
      pose(input.separator.pose, 'separator.pose');
      waypoints(input.separator.waypoints, 'separator.waypoints');
    }
  }
  let total = 0;
  const layerIds = new Set<string>();
  if (array(input.layers, 'layers')) {
    const layers = input.layers;
    layers.forEach((layer, i) => {
      const path = `layers[${i}]`;
      if (!record(layer)) { issue(path, 'layer', 'Expected a layer'); return; }
      if (text(layer.id, `${path}.id`)) {
        if (layerIds.has(layer.id)) issue(`${path}.id`, 'duplicate-id', 'Layer IDs must be unique');
        layerIds.add(layer.id);
      }
      if (text(layer.patternId, `${path}.patternId`)) {
        if (!patternIds.has(layer.patternId)) issue(`${path}.patternId`, 'missing-pattern', 'Referenced pattern does not exist');
        total += patternCounts.get(layer.patternId) ?? 0;
      }
      if (typeof layer.separatorAfter !== 'boolean') issue(`${path}.separatorAfter`, 'boolean', 'Expected a boolean');
      if (layer.separatorAfter === true) {
        total++;
        if (!record(input.separator)) issue(`${path}.separatorAfter`, 'missing-separator', 'A separator configuration is required');
      }
    });
  }
  if (total > MAX_PLAN_EVENTS) issue('layers', 'plan-limit', `The complete plan may contain at most ${MAX_PLAN_EVENTS} events`);
  if (issues.length === 0) issues.push(...validateTeaching(input as unknown as Recipe));
  return issues;
}

export class RecipeValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'RecipeValidationError';
    this.issues = issues;
  }
}
export function assertRecipe(input: unknown): asserts input is Recipe {
  const issues = validateRecipe(input);
  if (issues.length > 0) throw new RecipeValidationError(issues);
}
