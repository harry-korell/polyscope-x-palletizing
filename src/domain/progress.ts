import type { JointHint, Progress, Recipe, RecipeTeaching, ValidationIssue, WaypointTeaching } from './model.ts';
import { planEventCount } from './plan.ts';
import { assertRecipe } from './validation.ts';

/** Stable non-cryptographic 64-bit change detector; explicit recipe revision remains mandatory. */
export function recipeFingerprint(recipe: Recipe): string {
  assertRecipe(recipe);
  // Select known fields in a fixed order so JSON property ordering is irrelevant.
  const value = JSON.stringify({
    // Reject checkpoints from development-era reversal and columns-first grid policies.
    plannerVersion: 3,
    schemaVersion: recipe.schemaVersion, id: recipe.id, revision: recipe.revision,
    mode: recipe.mode, featurePose: recipe.featurePose, objectHeight: recipe.objectHeight,
    orientationPolicy: recipe.orientationPolicy ?? 'ps5-reference-relative',
    patterns: recipe.patterns.map(p => p.kind === 'line'
      ? { id: p.id, kind: p.kind, start: p.start, end: p.end, count: p.count }
      : p.kind === 'grid'
        ? { id: p.id, kind: p.kind, corners: p.corners, rows: p.rows, columns: p.columns }
        : { id: p.id, kind: p.kind, poses: p.poses }),
    layers: recipe.layers.map(l => ({ id: l.id, patternId: l.patternId, separatorAfter: l.separatorAfter })),
    waypoints: orderedWaypoints(recipe.waypoints),
    separator: recipe.separator ? {
      height: recipe.separator.height, pose: recipe.separator.pose,
      waypoints: orderedWaypoints(recipe.separator.waypoints),
    } : undefined,
    teaching: orderedTeaching(recipe.teaching),
  });
  let hash = 0xcbf29ce484222325n;
  // Hash UTF-16 code units deterministically in every JS runtime; this is not a security checksum.
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `v1-${hash.toString(16).padStart(16, '0')}`;
}
function orderedWaypoints(w: Recipe['waypoints']) {
  return { reference: w.reference, approach: w.approach, action: w.action, exit: w.exit };
}
function orderedHint(h: JointHint | null | undefined) {
  return h ? { q: h.q, sourcePose: h.sourcePose, featurePoseAtTeach: h.featurePoseAtTeach, robotType: h.robotType,
    tcp: h.tcp ? { id: h.tcp.id, name: h.tcp.name } : undefined, acquisition: h.acquisition } : h;
}
function orderedHintWaypoints(w: WaypointTeaching) {
  return { reference: orderedHint(w.reference), approach: orderedHint(w.approach), action: orderedHint(w.action), exit: orderedHint(w.exit) };
}
function orderedTeaching(t?: RecipeTeaching) {
  return t ? {
    version: t.version,
    patterns: Object.fromEntries(Object.keys(t.patterns).sort().map(id => {
      const p = t.patterns[id];
      return [id, p.kind === 'line' ? { kind: p.kind, start: orderedHint(p.start), end: orderedHint(p.end) }
        : p.kind === 'grid' ? { kind: p.kind, corners: p.corners.map(orderedHint) }
        : { kind: p.kind, pointIds: p.pointIds, hintsById: Object.fromEntries(Object.keys(p.hintsById).sort().map(key => [key, orderedHint(p.hintsById[key])])) }];
    })),
    waypoints: orderedHintWaypoints(t.waypoints),
    separator: t.separator ? { pose: orderedHint(t.separator.pose), waypoints: orderedHintWaypoints(t.separator.waypoints) } : undefined,
  } : undefined;
}
export function createProgress(recipe: Recipe): Progress {
  assertRecipe(recipe);
  return {
    schemaVersion: 1, recipeId: recipe.id, recipeRevision: recipe.revision,
    recipeFingerprint: recipeFingerprint(recipe), nextEventIndex: 0, phase: 'ready',
  };
}
export function validateProgress(recipe: Recipe, input: unknown): ValidationIssue[] {
  assertRecipe(recipe);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return [{ path: 'progress', code: 'progress', message: 'Expected a progress checkpoint' }];
  }
  const p = input as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const add = (field: string, code: string, message: string) => issues.push({ path: `progress.${field}`, code, message });
  if (p.schemaVersion !== 1) add('schemaVersion', 'version', 'Unsupported progress schema');
  if (p.recipeId !== recipe.id) add('recipeId', 'recipe-mismatch', 'Checkpoint belongs to another recipe');
  if (p.recipeRevision !== recipe.revision) add('recipeRevision', 'revision-mismatch', 'Recipe has changed; reset or explicitly select a new start');
  if (p.recipeFingerprint !== recipeFingerprint(recipe)) add('recipeFingerprint', 'geometry-mismatch', 'Recipe geometry or execution policy has changed');
  const count = planEventCount(recipe);
  const indexValid = typeof p.nextEventIndex === 'number' && Number.isSafeInteger(p.nextEventIndex) && p.nextEventIndex >= 0 && p.nextEventIndex <= count;
  if (!indexValid) add('nextEventIndex', 'index', 'Checkpoint index is outside the event plan');
  if (!['ready', 'in-progress', 'complete'].includes(p.phase as string)) add('phase', 'phase', 'Invalid checkpoint phase');
  else if (indexValid && ((p.phase === 'complete') !== (p.nextEventIndex === count))) {
    add('phase', 'phase-index', 'Only a completed checkpoint may point beyond the last event');
  }
  return issues;
}
function assertProgress(recipe: Recipe, progress: Progress): void {
  const issues = validateProgress(recipe, progress);
  if (issues.length) throw new Error(issues.map(issue => `${issue.path}: ${issue.message}`).join('; '));
}
/** Mark BEFORE approach or tool actions. Persisting this checkpoint is the adapter's responsibility. */
export function beginEvent(recipe: Recipe, progress: Progress): Progress {
  assertProgress(recipe, progress);
  if (progress.phase !== 'ready') throw new Error('Only a ready event can begin');
  return { ...progress, phase: 'in-progress' };
}
/** Commit AFTER the event's complete action and exit sequence has succeeded. */
export function completeEvent(recipe: Recipe, progress: Progress): Progress {
  assertProgress(recipe, progress);
  if (progress.phase !== 'in-progress') throw new Error('Only an in-progress event can complete');
  const nextEventIndex = progress.nextEventIndex + 1;
  return { ...progress, nextEventIndex, phase: nextEventIndex === planEventCount(recipe) ? 'complete' : 'ready' };
}
export type ResumeDecision = 'repeat-current' | 'skip-current' | 'restart';
/**
 * No motion is performed. Repeating a partly executed physical action requires operator reconciliation.
 * A completed plan stays completed until restart is explicitly selected.
 */
export function restoreProgress(recipe: Recipe, saved?: Progress, decision: ResumeDecision = 'repeat-current'): Progress {
  assertRecipe(recipe);
  if (!['repeat-current', 'skip-current', 'restart'].includes(decision)) throw new Error('Invalid resume decision');
  if (!recipe.rememberProgress || saved === undefined || decision === 'restart') return createProgress(recipe);
  assertProgress(recipe, saved);
  if (saved.phase === 'complete') return { ...saved };
  if (decision === 'skip-current') {
    const nextEventIndex = saved.nextEventIndex + 1;
    return { ...saved, nextEventIndex, phase: nextEventIndex === planEventCount(recipe) ? 'complete' : 'ready' };
  }
  return { ...saved, phase: 'ready' };
}
