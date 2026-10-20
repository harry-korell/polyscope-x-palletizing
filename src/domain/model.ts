/** All translations are metres; rotations are UR axis-angle vectors in radians. */
export type Pose = readonly [number, number, number, number, number, number];
export type Quaternion = readonly [number, number, number, number]; // x, y, z, w
/** Actual joint angles in radians; winding is preserved, never interpolated. */
export type JointVector = readonly [number, number, number, number, number, number];
export interface JointHint {
  q: JointVector;
  sourcePose: Pose;
  featurePoseAtTeach: Pose;
  robotType: string;
  tcp?: { id: string; name: string };
  acquisition: 'move-screen';
}
export type WaypointTeaching = Partial<Record<keyof WaypointTemplate, JointHint>>;
export type PatternTeaching =
  | { kind: 'line'; start?: JointHint; end?: JointHint }
  | { kind: 'grid'; corners: [JointHint | null, JointHint | null, JointHint | null, JointHint | null] }
  | { kind: 'irregular'; pointIds: string[]; hintsById: Record<string, JointHint> };
export interface RecipeTeaching {
  version: 1;
  patterns: Record<string, PatternTeaching>;
  waypoints: WaypointTeaching;
  separator?: { pose?: JointHint; waypoints: WaypointTeaching };
}

export interface PatternBase {
  id: string;
  name: string;
}
export interface LinePattern extends PatternBase {
  kind: 'line';
  start: Pose;
  end: Pose;
  count: number;
}
export interface GridPattern extends PatternBase {
  kind: 'grid';
  /** Cyclic corners 1..4; PS5 rows run corner1→corner2 first, columns corner1→corner4. */
  corners: readonly [Pose, Pose, Pose, Pose];
  rows: number;
  columns: number;
}
export interface IrregularPattern extends PatternBase {
  kind: 'irregular';
  poses: readonly Pose[];
}
export type Pattern = LinePattern | GridPattern | IrregularPattern;

/** Taught poses expressed in the pallet frame, at the bottom-layer datum. */
export interface WaypointTemplate {
  reference: Pose;
  approach: Pose;
  action: Pose;
  exit: Pose;
}
export interface Layer {
  id: string;
  patternId: string;
  separatorAfter: boolean;
}
export interface Separator {
  height: number;
  /** Target at the pallet bottom datum; the layer-top height is added at runtime. */
  pose: Pose;
  waypoints: WaypointTemplate;
}
export type OrientationPolicy = 'ps5-reference-relative' | 'fixed-feature';
export interface Recipe {
  schemaVersion: 1;
  /** Export marker for PS5 rows-first grid semantics. Adapters must migrate legacy JSON before planning. */
  plannerVersion?: 3;
  id: string;
  /** Increment whenever geometry, ordering, tool path or mode changes. */
  revision: number;
  name: string;
  mode: 'palletize' | 'depalletize';
  /** Pallet frame expressed in the robot base frame. */
  featurePose: Pose;
  objectHeight: number;
  patterns: readonly Pattern[];
  layers: readonly Layer[];
  waypoints: WaypointTemplate;
  separator?: Separator;
  rememberProgress: boolean;
  /** Defaults to PS5 sample formula; fixed-feature fixes approach/exit orientation only. */
  orientationPolicy?: OrientationPolicy;
  /** Optional measured joint configurations tied to local geometric anchors. */
  teaching?: RecipeTeaching;
}
export interface WaypointSet {
  approach: Pose;
  action: Pose;
  exit: Pose;
}
export interface PlanEventBase {
  /** Zero-based execution position after applying the selected mode. */
  eventIndex: number;
  layerIndex: number;
  layerId: string;
  height: number;
  poseInFeature: Pose;
  pose: Pose;
  waypointsInFeature: WaypointSet;
  waypoints: WaypointSet;
}
export interface ItemEvent extends PlanEventBase {
  kind: 'item';
  patternId: string;
  /** Zero-based geometric pattern index; PS5 grid rows advance first, independent of mode. */
  itemIndex: number;
  /** One-based ordinal in execution order; separators do not increment it. */
  itemOrdinal: number;
}
export interface SeparatorEvent extends PlanEventBase {
  kind: 'separator';
  operation: 'place' | 'remove';
}
export type PlanEvent = ItemEvent | SeparatorEvent;
export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}
export const MAX_PLAN_EVENTS = 10_000;

/** Progress is a checkpoint, not proof that a physical gripper action completed. */
export interface Progress {
  schemaVersion: 1;
  recipeId: string;
  recipeRevision: number;
  /** Detects accidental configuration changes without a revision bump. */
  recipeFingerprint: string;
  nextEventIndex: number;
  phase: 'ready' | 'in-progress' | 'complete';
}
