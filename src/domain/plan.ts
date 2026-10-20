import type { OrientationPolicy, Pattern, PlanEvent, Pose, Recipe, WaypointSet, WaypointTemplate } from './model.ts';
import { composePoses, interpolatePose, inversePose, translatePose } from './pose.ts';
import { assertRecipe } from './validation.ts';

export function patternItemCount(pattern: Pattern): number {
  switch (pattern.kind) {
    case 'line': return pattern.count;
    case 'grid': return pattern.rows * pattern.columns;
    case 'irregular': return pattern.poses.length;
  }
}
/** Caller supplies a validated pattern. Single-row/column grids use u/v = 0. */
export function patternPoseAt(pattern: Pattern, index: number): Pose {
  const count = patternItemCount(pattern);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new RangeError('Pattern item index out of bounds');
  switch (pattern.kind) {
    case 'line': return interpolatePose(pattern.start, pattern.end, count === 1 ? 0 : index / (count - 1));
    case 'irregular': return [...pattern.poses[index]];
    case 'grid': {
      const row = index % pattern.rows;
      const column = Math.floor(index / pattern.rows);
      const u = pattern.rows === 1 ? 0 : row / (pattern.rows - 1);
      const v = pattern.columns === 1 ? 0 : column / (pattern.columns - 1);
      const [c1, c2, c3, c4] = pattern.corners;
      return interpolatePose(interpolatePose(c1, c2, u), interpolatePose(c4, c3, u), v);
    }
  }
}

/**
 * All displacements remain in the feature frame. The default orientation is
 * R_waypoint * inverse(R_reference) * R_item, matching the cited PS5 script sample.
 * fixed-feature additionally keeps approach/exit absolute orientations fixed.
 * Tool action continues to follow the reference-relative rotation in both modes.
 */
export function resolveWaypoints(template: WaypointTemplate, targetInFeature: Pose, policy: OrientationPolicy = 'ps5-reference-relative'): WaypointSet {
  const delta: readonly [number, number, number] = [
    targetInFeature[0] - template.reference[0],
    targetInFeature[1] - template.reference[1],
    targetInFeature[2] - template.reference[2],
  ];
  const onlyRotation = (p: Pose): Pose => [0, 0, 0, p[3], p[4], p[5]];
  const targetRotation = onlyRotation(targetInFeature);
  const inverseReferenceRotation = inversePose(onlyRotation(template.reference));
  const resolve = (p: Pose, fixed: boolean): Pose => {
    const translated = translatePose(p, delta);
    if (fixed) return translated;
    const rotated = composePoses(composePoses(onlyRotation(p), inverseReferenceRotation), targetRotation);
    return [translated[0], translated[1], translated[2], rotated[3], rotated[4], rotated[5]];
  };
  return { approach: resolve(template.approach, policy === 'fixed-feature'), action: resolve(template.action, false), exit: resolve(template.exit, policy === 'fixed-feature') };
}
export function transformWaypoints(featurePose: Pose, local: WaypointSet): WaypointSet {
  return {
    approach: composePoses(featurePose, local.approach),
    action: composePoses(featurePose, local.action),
    exit: composePoses(featurePose, local.exit),
  };
}

/**
 * Builds physical layers bottom-up. Depalletizing visits layers top-down while
 * preserving each pattern's item order, with its top separator removed first.
 * This ordering follows the GUI-generated PS5 5.26.1 line reference program.
 * No reachability, collision clearance or hardware motion is implied by a valid plan.
 */
export function buildPlan(recipe: Recipe): PlanEvent[] {
  assertRecipe(recipe);
  const layerEvents: PlanEvent[][] = [];
  const patterns = new Map(recipe.patterns.map(pattern => [pattern.id, pattern]));
  let height = 0;
  recipe.layers.forEach((layer, layerIndex) => {
    const events: PlanEvent[] = [];
    layerEvents.push(events);
    const pattern = patterns.get(layer.patternId)!;
    for (let itemIndex = 0; itemIndex < patternItemCount(pattern); itemIndex++) {
      const poseInFeature = translatePose(patternPoseAt(pattern, itemIndex), [0, 0, height]);
      const waypointsInFeature = resolveWaypoints(recipe.waypoints, poseInFeature, recipe.orientationPolicy);
      events.push({
        kind: 'item', eventIndex: events.length, layerIndex, layerId: layer.id,
        patternId: pattern.id, itemIndex, itemOrdinal: 0, height,
        poseInFeature, pose: composePoses(recipe.featurePose, poseInFeature),
        waypointsInFeature, waypoints: transformWaypoints(recipe.featurePose, waypointsInFeature),
      });
    }
    height += recipe.objectHeight;
    if (layer.separatorAfter) {
      const separator = recipe.separator!;
      const poseInFeature = translatePose(separator.pose, [0, 0, height]);
      const waypointsInFeature = resolveWaypoints(separator.waypoints, poseInFeature, recipe.orientationPolicy);
      events.push({
        kind: 'separator', operation: recipe.mode === 'palletize' ? 'place' : 'remove',
        eventIndex: events.length, layerIndex, layerId: layer.id, height,
        poseInFeature, pose: composePoses(recipe.featurePose, poseInFeature),
        waypointsInFeature, waypoints: transformWaypoints(recipe.featurePose, waypointsInFeature),
      });
      height += separator.height;
    }
  });
  const events = recipe.mode === 'depalletize'
    ? layerEvents.slice().reverse().flatMap(events => {
      const separator = events.at(-1);
      return separator?.kind === 'separator' ? [separator, ...events.slice(0, -1)] : events;
    })
    : layerEvents.flat();
  let itemOrdinal = 0;
  return events.map((event, eventIndex) => event.kind === 'item'
    ? { ...event, eventIndex, itemOrdinal: ++itemOrdinal }
    : { ...event, eventIndex });
}

export function planEventCount(recipe: Recipe): number {
  assertRecipe(recipe);
  const counts = new Map(recipe.patterns.map(pattern => [pattern.id, patternItemCount(pattern)]));
  return recipe.layers.reduce((n, layer) => n + counts.get(layer.patternId)! + (layer.separatorAfter ? 1 : 0), 0);
}
