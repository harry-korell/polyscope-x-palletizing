import { convertPose, PoseUtils } from '@universal-robots/contribution-api';
import type { Frame, FramesService } from '@universal-robots/contribution-api';
import type { Pose } from '../../src/domain/index.ts';

/** Resolve a snapshot for teaching/preview. Runtime resolves the selected frame again. */
export function featurePoseFromFrames(frames: readonly Frame[], name: string): Pose {
  if (['tcp','flange'].includes(name) || !frames.some(f => f.name === name) || !frames.some(f => f.name === 'base')) throw new Error('Palettenframe oder Basisframe ist nicht verfügbar.');
  // Guard the SDK converter's traversal against incomplete/cyclic parent graphs.
  const byName = new Map(frames.map(frame => [frame.name, frame]));
  const roots = new Set<string>();
  for (const start of [name, 'base']) {
    const seen = new Set<string>(); let current: string | undefined = start;
    while (current) {
      if (seen.has(current)) throw new Error('Zyklische Frame-Hierarchie.');
      seen.add(current); const frame = byName.get(current);
      if (!frame) throw new Error(`Frame ${current} ist nicht verfügbar.`);
      if (!frame.parent) roots.add(current);
      current = frame.parent;
    }
  }
  if (roots.size !== 1) throw new Error('Palettenframe und Basisframe haben keinen gemeinsamen Ursprung.');
  const converted = convertPose(PoseUtils.controllerPoseIdentityInFrame(name), 'base', [...frames]);
  if (converted.referenceFrame !== 'base') throw new Error('Palettenframe konnte nicht in den Basisframe umgerechnet werden.');
  const pose = PoseUtils.asPose(converted);
  const result = [...pose.position, ...pose.orientation];
  if (result.length !== 6 || !result.every(Number.isFinite)) throw new Error('Palettenframe enthält ungültige Koordinaten.');
  return result as unknown as Pose;
}

export async function readFrameSnapshot(service: Pick<FramesService,'observeFrames'>): Promise<Frame[]> {
  return await new Promise<Frame[]>((resolve,reject)=>{
    let subscription:{unsubscribe():void}|undefined;let settled=false;
    const finish=(error:unknown,frames?:Frame[])=>{if(settled)return;settled=true;clearTimeout(timeout);queueMicrotask(()=>subscription?.unsubscribe());error?reject(error):resolve(frames!);};
    const timeout=setTimeout(()=>finish(new Error('PolyScope-Frames konnten nicht geladen werden.')),5000);
    try{subscription=service.observeFrames().subscribe({next:frames=>{if(frames.some(f=>f.name==='base'))finish(undefined,frames);},error:error=>finish(error)});}catch(error){finish(error);}
  });
}
