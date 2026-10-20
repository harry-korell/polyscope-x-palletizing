import type { Pose, Recipe, WaypointTemplate } from './model.ts';

/** Demonstration geometry for the simulator. These are NOT taught robot positions. */
export function createDefaultRecipe(id = 'pallet-1'): Recipe {
  const reference: Pose = [0, 0, 0, Math.PI, 0, 0];
  const waypoints: WaypointTemplate = {
    reference: [...reference], action: [...reference],
    approach: [0, 0, 0.1, Math.PI, 0, 0],
    exit: [0, 0, 0.1, Math.PI, 0, 0],
  };
  return {
    schemaVersion: 1, plannerVersion: 3, id, revision: 1, name: 'Palettierassistent',
    mode: 'palletize', featurePose: [0.4, -0.2, 0.2, 0, 0, 0], objectHeight: 0.1,
    patterns: [{
      id: 'grid-1', name: 'Raster 1', kind: 'grid', rows: 2, columns: 2,
      corners: [reference, [0.2, 0, 0, Math.PI, 0, 0], [0.2, 0.2, 0, Math.PI, 0, 0], [0, 0.2, 0, Math.PI, 0, 0]],
    }],
    layers: [{ id: 'layer-1', patternId: 'grid-1', separatorAfter: false }],
    waypoints, rememberProgress: false, orientationPolicy: 'ps5-reference-relative',
  };
}
