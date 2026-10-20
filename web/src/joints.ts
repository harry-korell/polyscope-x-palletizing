import type { JointPositions, MoveScreenOptions, Waypoint } from '@universal-robots/contribution-api';
import { buildPlan, jointHintForEvent, orientationDistance } from '../../src/domain/index.ts';
import type { JointHint, Pose } from '../../src/domain/index.ts';
import { motionSettings } from './model.ts';
import type { PalletNode } from './model.ts';

const names=['base','shoulder','elbow','wrist1','wrist2','wrist3'] as const;
export function jointTuple(q:JointPositions):Pose {
  const values=names.map(name=>q[name]);
  if(!values.every(Number.isFinite))throw new Error('Move-Screen hat keine vollständige Gelenkstellung geliefert.');
  return values as unknown as Pose;
}
export function jointObject(q:Pose):JointPositions { return Object.fromEntries(names.map((name,i)=>[name,q[i]])) as unknown as JointPositions; }
/** Active_TCP can omit its identity on Save. Pin the named, measured TCP instead. */
export function lockedTeachOptions(current:Waypoint,label:string):MoveScreenOptions {
  if(!current.tcp?.id||!current.tcp.name)throw new Error('Der aktive TCP konnte nicht eindeutig bestimmt werden. Einen benannten TCP aktivieren und erneut einlernen.');
  return{moveScreenTarget:'waypoint',moveScreenTargetLabel:label,frame:'base',frameSelectionDisabled:true,tcp:{...current.tcp},tcpSelectionDisabled:true};
}
export function assertTeachTcp(position:Waypoint,expected:Waypoint['tcp']):void {
  if(!expected?.id||!position.tcp?.id||position.tcp.id!==expected.id)throw new Error('Der Move-Screen hat den festgelegten TCP nicht bestätigt. Gelenkhinweis wurde nicht gespeichert.');
}
export function atTarget(actual:Pose,target:Pose):boolean { return Math.hypot(...actual.slice(0,3).map((v,i)=>v-target[i]))<=0.0001&&orientationDistance(actual,target)<=0.001; }
export function measuredHint(position:Waypoint,sourcePose:Pose,featurePoseAtTeach:Pose,robotType:string):JointHint {
  return{q:jointTuple(position.qNear),sourcePose:[...sourcePose],featurePoseAtTeach:[...featurePoseAtTeach],robotType,tcp:position.tcp?{...position.tcp}:undefined,acquisition:'move-screen'};
}
export function hintCompatibility(hint:JointHint,robotType:string,tcp?:{id:string;name:string}):string|undefined{
  if(hint.robotType!==robotType)return 'Gelenkstellung stammt von einem anderen Robotertyp. Neu einlernen oder aktuelle Gelenkstellung wählen.';
  if(!hint.tcp?.id||!tcp?.id||hint.tcp.id!==tcp.id)return 'TCP-Identität der Gelenkstellung kann für den aktuellen TCP nicht bestätigt werden. Neu einlernen oder aktuelle Gelenkstellung wählen.';
}
export function jointRuntimeErrors(node:PalletNode,robotType:string,tcp?:{id:string;name:string}):string[]{
  const errors=new Set<string>(),profiles=motionSettings(node);
  for(const event of buildPlan(node.parameters.recipe))for(const phase of ['approach','action','exit'] as const){
    const profile=profiles[event.kind][phase];
    if(profile.type==='joint'&&profile.qNearMode==='taught'){
      const {sourceKey,hint}=jointHintForEvent(node.parameters.recipe,event,phase);
      if(!hint)errors.add(`${sourceKey}: Gelenkstellung fehlt.`);
      else{const error=hintCompatibility(hint,robotType,tcp);if(error)errors.add(`${sourceKey}: ${error}`);}
    }
  }
  return [...errors];
}
export function requiresTaughtJoints(node:PalletNode):boolean { return Object.values(motionSettings(node)).some(set=>Object.values(set).some(profile=>profile.type==='joint'&&profile.qNearMode==='taught')); }
