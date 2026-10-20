import type { Pose, Quaternion } from './model.ts';

const EPS = 1e-12;
export const IDENTITY_POSE: Pose = [0, 0, 0, 0, 0, 0];

function normalized(q: Quaternion): Quaternion {
  const n = Math.hypot(...q);
  if (!Number.isFinite(n) || n < EPS) throw new RangeError('Invalid quaternion');
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
export function rotationVectorToQuaternion(v: readonly [number, number, number]): Quaternion {
  const angle = Math.hypot(...v);
  if (!Number.isFinite(angle)) throw new RangeError('Invalid rotation vector');
  if (angle < EPS) return normalized([v[0] / 2, v[1] / 2, v[2] / 2, 1]);
  const k = Math.sin(angle / 2) / angle;
  return normalized([v[0] * k, v[1] * k, v[2] * k, Math.cos(angle / 2)]);
}
export function quaternionToRotationVector(input: Quaternion): readonly [number, number, number] {
  let q = normalized(input);
  // q and -q describe the same orientation; choose a canonical shortest vector.
  if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
  const s = Math.hypot(q[0], q[1], q[2]);
  if (s < EPS) return [2 * q[0], 2 * q[1], 2 * q[2]];
  const k = 2 * Math.atan2(s, q[3]) / s;
  return [q[0] * k, q[1] * k, q[2] * k];
}
export function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  return normalized([
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]);
}
function rotation(p: Pose): Quaternion {
  return rotationVectorToQuaternion([p[3], p[4], p[5]]);
}
export function rotateVector(qInput: Quaternion, v: readonly [number, number, number]): readonly [number, number, number] {
  const q = normalized(qInput);
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]);
  const ty = 2 * (q[2] * v[0] - q[0] * v[2]);
  const tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [
    v[0] + q[3] * tx + q[1] * tz - q[2] * ty,
    v[1] + q[3] * ty + q[2] * tx - q[0] * tz,
    v[2] + q[3] * tz + q[0] * ty - q[1] * tx,
  ];
}
/** Rigid composition, equivalent to UR pose_trans(parent, child). */
export function composePoses(parent: Pose, child: Pose): Pose {
  const r = rotation(parent);
  const t = rotateVector(r, [child[0], child[1], child[2]]);
  const v = quaternionToRotationVector(multiplyQuaternions(r, rotation(child)));
  return [parent[0] + t[0], parent[1] + t[1], parent[2] + t[2], ...v];
}
export function inversePose(p: Pose): Pose {
  const q = rotation(p);
  const inv: Quaternion = [-q[0], -q[1], -q[2], q[3]];
  const t = rotateVector(inv, [-p[0], -p[1], -p[2]]);
  return [...t, ...quaternionToRotationVector(inv)];
}
export function toFeaturePose(featureInBase: Pose, poseInBase: Pose): Pose {
  return composePoses(inversePose(featureInBase), poseInBase);
}
/** Shortest-geodesic orientation interpolation; never interpolate rotvec components. */
export function slerp(aInput: Quaternion, bInput: Quaternion, alpha: number): Quaternion {
  if (!Number.isFinite(alpha)) throw new RangeError('Invalid interpolation fraction');
  const a = normalized(aInput);
  let b = normalized(bInput);
  let dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
  if (dot < 0) {
    b = [-b[0], -b[1], -b[2], -b[3]];
    dot = -dot;
  }
  dot = Math.min(1, Math.max(-1, dot));
  if (dot > 1 - 1e-12) return normalized(a.map((v, i) => v + alpha * (b[i] - v)) as unknown as Quaternion);
  const theta = Math.acos(dot);
  const scaleA = Math.sin((1 - alpha) * theta) / Math.sin(theta);
  const scaleB = Math.sin(alpha * theta) / Math.sin(theta);
  return normalized(a.map((v, i) => scaleA * v + scaleB * b[i]) as unknown as Quaternion);
}
export function interpolatePose(a: Pose, b: Pose, alpha: number): Pose {
  if (!Number.isFinite(alpha)) throw new RangeError('Invalid interpolation fraction');
  if (alpha === 0) return [...a];
  if (alpha === 1) return [...b];
  const rv = quaternionToRotationVector(slerp(rotation(a), rotation(b), alpha));
  return [a[0] + alpha * (b[0] - a[0]), a[1] + alpha * (b[1] - a[1]), a[2] + alpha * (b[2] - a[2]), ...rv];
}
/** Translation in the coordinates of p's parent frame, preserving orientation. */
export function translatePose(p: Pose, delta: readonly [number, number, number]): Pose {
  return [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2], p[3], p[4], p[5]];
}
export function orientationDistance(a: Pose, b: Pose): number {
  const qa = rotation(a);
  const qb = rotation(b);
  const dot = Math.abs(qa.reduce((sum, value, i) => sum + value * qb[i], 0));
  return 2 * Math.acos(Math.min(1, dot));
}
