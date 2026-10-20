import type { BranchNode, ProgramNode, ScriptContext, ValidationContext, VariableDeclaration } from '@universal-robots/contribution-api';
import { buildPlan, createDefaultRecipe, jointHintForEvent, patternItemCount, patternPoseAt, validateRecipe } from '../../src/domain/index.ts';
import type { Recipe } from '../../src/domain/index.ts';
import { setupErrors } from './setup.ts';
import type { SetupMetadata } from './setup.ts';

export const PALLET_TYPE = 'hk-palletizing-pallet';
export const PHASE_TYPE = 'hk-palletizing-phase';
// Bump when generated runtime behavior changes: PSX can retain serialized code.
export const NODE_VERSION = '1.1.0';
export const DEPALLET_PLANNER_VERSION = 2;
export const CURRENT_PLANNER_VERSION = 3;
export function requiredPlannerVersion(recipe:Recipe):number { return recipe.patterns.some(p=>p.kind==='grid')?CURRENT_PLANNER_VERSION:recipe.mode==='depalletize'?DEPALLET_PLANNER_VERSION:0; }
export function plannerApproved(node:PalletNode):boolean { return node.parameters.approvedRevision===node.parameters.recipe.revision&&(node.parameters.approvedPlannerVersion??0)>=requiredPlannerVersion(node.parameters.recipe); }
export type Phase = 'before' | 'cycle' | 'item-prepare' | 'separator-prepare' | 'approach' | 'action' | 'exit' | 'item' | 'separator' | 'item-after' | 'separator-after' | 'after';
export const PHASE_LABEL: Record<Phase, string> = { before: 'Vor Palettierung', cycle: 'An jedem Teil', 'item-prepare': 'Teil vorbereiten / aufnehmen', 'separator-prepare': 'Zwischenlage vorbereiten / aufnehmen', approach: 'Anfahrpunkt', action: 'Werkzeug-Aktionspunkt', exit: 'Ausfahrpunkt', item: 'Teil-Aktionen', separator: 'Zwischenlagen-Aktionen', 'item-after': 'Teil ablegen / nachbereiten', 'separator-after': 'Zwischenlage ablegen / nachbereiten', after: 'Nach Palettierung' };
const RESERVED = new Set(['and','break','continue','def','elif','else','end','False','for','global','halt','if','in','local','not','or','return','run','sec','shared','thread','True','while','None']);
export function validIdentifier(name: unknown): name is string { return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name) && !name.startsWith('hkpa_'); }
export type MotionPhase = 'approach' | 'action' | 'exit';
export type MotionKind = 'item' | 'separator';
export interface MotionProfile { type: 'linear' | 'joint'; speed: number; acceleration: number; blend: number; qNearMode?: 'taught' | 'current'; }
export type MotionSettings = Record<MotionKind, Record<MotionPhase, MotionProfile>>;
export interface PalletNode extends ProgramNode {
  type: typeof PALLET_TYPE;
  parameters: {
    recipe: Recipe;
    runtimeId: string;
    itemCounter: VariableDeclaration;
    totalCounter: VariableDeclaration;
    taught: Record<string, boolean>;
    approvedRevision?: number;
    approvedPlannerVersion?: number;
    resumeVariable?: string;
    /** Atomic pair [event cursor, pending native-counter override]; -1 imports the legacy cursor once. */
    resumeStateVariable?: string;
    resumeRevision?: number;
    resumePlannerVersion?: number;
    speed: number;
    acceleration: number;
    blend: number;
    autoRepeat: boolean;
    /** First item on a fresh program start when persistent progress is disabled. */
    startItem?: number;
    /** Existing PolyScope world-model frame; undefined uses recipe.featurePose snapshot. */
    featureFrame?: string;
    motion?: MotionSettings;
    referenceSelection?: { patternId: string; itemIndex: number };
    setup?: SetupMetadata;
    copySourceCounters?: { oldItemId: string; oldTotalId: string };
    pendingRemap?: { oldItemId: string; oldTotalId: string };
  };
}
export interface PhaseNode extends ProgramNode { type: typeof PHASE_TYPE; parameters: { phase: Phase }; }
export function id(): string { return crypto.randomUUID().replaceAll('-', '').slice(0, 16); }
export function prefix(node: PalletNode): string { return `hkpa_${node.parameters.runtimeId}`; }
export function motionSettings(node: PalletNode): MotionSettings {
  if(node.parameters.motion)return node.parameters.motion;
  const profile=(phase:MotionPhase):MotionProfile=>({type:'linear',speed:node.parameters.speed,acceleration:node.parameters.acceleration,blend:phase==='approach'?node.parameters.blend:0});
  const set=()=>({approach:profile('approach'),action:profile('action'),exit:profile('exit')});
  return {item:set(),separator:set()};
}
/** A selected reference remains tied to pattern geometry when that pattern is edited. */
export function synchronizeReference(node: PalletNode): void {
  const selection=node.parameters.referenceSelection;if(!selection||validateRecipe(node.parameters.recipe).length)return;
  const pattern=node.parameters.recipe.patterns.find(p=>p.id===selection.patternId);
  if(!pattern||!Number.isSafeInteger(selection.itemIndex)||selection.itemIndex<0||selection.itemIndex>=patternItemCount(pattern))return;
  const pose=patternPoseAt(pattern,selection.itemIndex);
  if(pose.some((value,i)=>Math.abs(value-node.parameters.recipe.waypoints.reference[i])>1e-10)){
    node.parameters.recipe.waypoints.reference=pose;
    for(const phase of ['approach','action','exit'])node.parameters.taught[phase]=false;
  }
  const keys=requiredTeachKeys(node.parameters.recipe).filter(key=>key.startsWith(`${pattern.id}.`));
  node.parameters.taught.reference=keys.every(key=>node.parameters.taught[key]===true);
}
export function phaseNode(phase: Phase, children?: ProgramNode[]): PhaseNode | BranchNode {
  const result: PhaseNode = { type: PHASE_TYPE, version: NODE_VERSION, locked: true, allowsChildren: !['approach', 'exit'].includes(phase), lockChildren: ['cycle', 'action'].includes(phase), parameters: { phase } };
  return children ? { ...result, children } : result;
}
export function createPallet(): PalletNode & BranchNode {
  const runtimeId = id();
  const recipe = createDefaultRecipe(id());
  return {
    type: PALLET_TYPE, version: NODE_VERSION, allowsChildren: true, lockChildren: true,
    parameters: { recipe, runtimeId, itemCounter: { id: id(), name: `PalletItem_${runtimeId.slice(0,6)}`, valueType: 'integer', _IDENTIFIER: 'VariableDeclaration' }, totalCounter: { id: id(), name: `PalletTotal_${runtimeId.slice(0,6)}`, valueType: 'integer', _IDENTIFIER: 'VariableDeclaration' }, taught: {}, approvedPlannerVersion: CURRENT_PLANNER_VERSION, speed: 0.1, acceleration: 0.25, blend: 0, autoRepeat: true },
    children: [phaseNode('before'), phaseNode('cycle', [phaseNode('item-prepare'), phaseNode('separator-prepare'), phaseNode('approach'), phaseNode('action', [phaseNode('item'), phaseNode('separator')]), phaseNode('exit'), phaseNode('item-after'), phaseNode('separator-after')]), phaseNode('after')],
  };
}
/** New UI defaults are an explicit unreviewed construction, separate from legacy fixtures. */
export function createSimplePallet(): PalletNode & BranchNode {
  const node = createPallet(), patternId = node.parameters.recipe.patterns[0].id;
  node.parameters.referenceSelection = { patternId, itemIndex: 0 };
  node.parameters.setup = { version: 1, rectangles: { [patternId]: { kind: 'axis-aligned' } }, vertical: { kind: 'vertical', patternId, clearance: 0.1 } };
  return node;
}
export function requiredTeachKeys(recipe: Recipe): string[] {
  const keys = ['feature', 'reference', 'approach', 'action', 'exit'];
  for (const p of recipe.patterns) {
    if (p.kind === 'line') keys.push(`${p.id}.start`, `${p.id}.end`);
    if (p.kind === 'grid') keys.push(...p.corners.map((_, i) => `${p.id}.corner${i}`));
    if (p.kind === 'irregular') keys.push(...p.poses.map((_, i) => `${p.id}.point${i}`));
  }
  if (recipe.layers.some(l => l.separatorAfter)) keys.push('separator.pose', 'separator.reference', 'separator.approach', 'separator.action', 'separator.exit');
  return keys;
}
export function nodeErrors(node: PalletNode): string[] {
  if (!node || typeof node !== 'object' || !node.parameters || typeof node.parameters !== 'object') return ['Knotenparameter fehlen.'];
  const p = node.parameters;
  const errors = validateRecipe(p.recipe).map(x => `${x.path}: ${x.message}`);
  if (errors.length) return errors;
  if (node.version !== NODE_VERSION) errors.push('Knotenversion wird nicht unterstützt. Programm erneut laden und Migration prüfen.');
  if (p.recipe.patterns.some(pattern=>pattern.kind==='grid')&&p.recipe.plannerVersion!==3) errors.push('Rasterrezept muss vor der Ausführung migriert oder erneut importiert werden.');
  const counts = new Map(p.recipe.patterns.map(pattern => [pattern.id, patternItemCount(pattern)]));
  const itemCount = p.recipe.layers.reduce((sum, layer) => sum + counts.get(layer.patternId)!, 0);
  if (p.startItem !== undefined && (!Number.isSafeInteger(p.startItem) || p.startItem < 1 || p.startItem > itemCount)) errors.push(`Startteil muss zwischen 1 und ${itemCount} liegen.`);
  if(p.pendingRemap!==undefined)errors.push('Eingefügten Knoten über „Assistent öffnen“ fertigstellen, damit Zählerreferenzen zugeordnet werden.');
  if (typeof p.autoRepeat !== 'boolean') errors.push('Paletten-Wiederholung muss ein boolescher Wert sein.');
  if (p.recipe.patterns.some(pattern => !/^[A-Za-z0-9_-]+$/.test(pattern.id) || pattern.id === 'separator')) errors.push('Musterkennung ist ungültig. Rezept erneut importieren.');
  if (typeof p.runtimeId !== 'string' || !/^[a-f0-9]{16}$/.test(p.runtimeId)) errors.push('Instanzkennung ist ungültig.');
  if (p.featureFrame !== undefined && (typeof p.featureFrame !== 'string' || !p.featureFrame.length || p.featureFrame.length > 128 || /[\u0000-\u001f]/.test(p.featureFrame) || ['tcp','flange'].includes(p.featureFrame))) errors.push('Palettenframe ist ungültig.');
  const validCounter = (c: VariableDeclaration) => c && validIdentifier(c.name) && c._IDENTIFIER === 'VariableDeclaration' && c.valueType === 'integer' && typeof c.id === 'string' && c.id.length > 0;
  if (!validCounter(p.itemCounter)) errors.push('Teilezähler ist ungültig.');
  if (!validCounter(p.totalCounter)) errors.push('Gesamtzähler ist ungültig.');
  if (p.itemCounter?.name === p.totalCounter?.name) errors.push('Zählernamen müssen verschieden sein.');
  if (p.itemCounter?.id === p.totalCounter?.id) errors.push('Zählerkennungen müssen verschieden sein.');
  if (!p.taught || typeof p.taught !== 'object') return [...errors, 'Einlernstatus fehlt.'];
  errors.push(...setupErrors(node));
  if (!Number.isFinite(p.speed) || p.speed <= 0 || p.speed > 1) errors.push('Geschwindigkeit muss zwischen 0 und 1000 mm/s liegen.');
  if (!Number.isFinite(p.acceleration) || p.acceleration <= 0 || p.acceleration > 2) errors.push('Beschleunigung muss zwischen 0 und 2000 mm/s² liegen.');
  if (!Number.isFinite(p.blend) || p.blend < 0 || p.blend > 0.1) errors.push('Überschleifradius muss zwischen 0 und 100 mm liegen.');
  if(p.motion!==undefined){
    for(const kind of ['item','separator'] as const)for(const phase of ['approach','action','exit'] as const){
      const profile=p.motion?.[kind]?.[phase];
      if(!profile||!['linear','joint'].includes(profile.type)||!Number.isFinite(profile.speed)||profile.speed<=0||profile.speed>(profile.type==='joint'?Math.PI:1)||!Number.isFinite(profile.acceleration)||profile.acceleration<=0||profile.acceleration>(profile.type==='joint'?2*Math.PI:2)||!Number.isFinite(profile.blend)||profile.blend<0||profile.blend>0.1||(phase==='action'&&profile.blend!==0))errors.push(`Bewegungsprofil ${kind}/${phase} ist ungültig.`);
      if(profile?.type==='joint'&&!['taught','current'].includes(profile.qNearMode??''))errors.push(`Gelenkhinweis für ${kind}/${phase} ausdrücklich wählen.`);
    }
  }
  if(p.motion)for(const event of buildPlan(p.recipe))for(const phase of ['approach','action','exit'] as const){
    const profile=p.motion[event.kind]?.[phase];
    if(profile?.type==='joint'&&profile.qNearMode==='taught'){
      const resolved=jointHintForEvent(p.recipe,event,phase);
      if(!resolved.hint){const message=`Gelenkstellung für ${resolved.sourceKey} fehlt. Einlernen oder „Aktuelle Gelenkstellung“ ausdrücklich wählen.`;if(!errors.includes(message))errors.push(message);}
    }
  }
  if(p.referenceSelection!==undefined){
    const selected=p.referenceSelection;const pattern=p.recipe.patterns.find(pattern=>pattern.id===selected?.patternId);
    if(!pattern||!Number.isSafeInteger(selected.itemIndex)||selected.itemIndex<0||selected.itemIndex>=patternItemCount(pattern))errors.push('Referenzteil ist nicht mehr im gewählten Muster vorhanden.');
    else if(patternPoseAt(pattern,selected.itemIndex).some((v,i)=>Math.abs(v-p.recipe.waypoints.reference[i])>1e-10))errors.push('Referenzteil und Referenzpose stimmen nicht überein.');
  }
  const missing = requiredTeachKeys(p.recipe).filter(k => p.taught[k] !== true);
  if (missing.length) errors.push(`Noch ${missing.length} Positionen einlernen oder bewusst prüfen.`);
  if (p.approvedRevision !== p.recipe.revision) errors.push('Rezept und Bewegungsfolge noch nicht freigegeben.');
  if ((p.approvedPlannerVersion??0)<requiredPlannerVersion(p.recipe)) errors.push('Raster-/Depalettierfolge wurde an PolyScope 5 angepasst. Geometrie und Reihenfolge prüfen und erneut freigeben.');
  if (p.recipe.rememberProgress && (!p.resumeVariable || p.resumeRevision !== p.recipe.revision)) errors.push('Fortschrittsspeicher für diese Rezeptrevision noch nicht eingerichtet.');
  if (p.recipe.rememberProgress && (p.resumePlannerVersion??0)<requiredPlannerVersion(p.recipe)) errors.push('Gespeicherter Fortschritt gehört zur alten Ablaufreihenfolge. Fortschritt bewusst zurücksetzen.');
  if (p.resumeVariable && p.resumeVariable !== `${prefix(node)}_resume`) errors.push('Fortschrittsspeicher gehört nicht zu dieser Instanz.');
  if (p.recipe.rememberProgress && p.resumeStateVariable !== `${prefix(node)}_resume_state`) errors.push('Erweiterten Fortschrittsspeicher im Assistenten mit „Übernehmen“ einrichten. Der vorhandene Checkpoint bleibt erhalten.');
  return errors;
}
export function phaseChildrenErrors(parent: string, children: readonly ProgramNode[]): string[] {
  if (!Array.isArray(children) || children.some(n => !n || typeof n !== 'object' || (n.type === PHASE_TYPE && n.isSuppressed))) return ['Interne Ablaufknoten fehlen oder sind unterdrückt.'];
  const expected = parent === PALLET_TYPE ? ['before','cycle','after'] : parent === 'cycle' ? ['item-prepare','separator-prepare','approach','action','exit','item-after','separator-after'] : parent === 'action' ? ['item','separator'] : [];
  const actual = children.filter(n => n.type === PHASE_TYPE).map(n => n.parameters?.phase);
  const fixed = [PALLET_TYPE, 'cycle', 'action', 'approach', 'exit'].includes(parent);
  const valid = (parent === PALLET_TYPE || Object.hasOwn(PHASE_LABEL, parent)) && JSON.stringify(actual) === JSON.stringify(expected) && !children.some(n => n.type === PALLET_TYPE) && (!fixed || children.length === expected.length);
  return valid ? [] : ['Die interne Ablaufstruktur wurde verändert. Knoten neu anlegen und Benutzeraktionen übertragen.'];
}
export function phaseParentValid(phase: string, parent: ProgramNode | undefined): boolean {
  if (!parent) return false;
  if (['before','cycle','after'].includes(phase)) return parent.type === PALLET_TYPE;
  if (['item-prepare','separator-prepare','approach','action','exit','item-after','separator-after'].includes(phase)) return parent.type === PHASE_TYPE && parent.parameters?.phase === 'cycle';
  return ['item','separator'].includes(phase) && parent.type === PHASE_TYPE && parent.parameters?.phase === 'action';
}
/** PSX 10.15 validation ancestors starts with the node itself, then its parent. */
export async function phaseValidInTree(node: PhaseNode, context: ValidationContext): Promise<boolean> {
  if (!node.parameters || !Object.hasOwn(PHASE_LABEL, node.parameters.phase)) return false;
  const self = (await context.traverse.ancestors.next()).value;
  if (self?.type !== PHASE_TYPE || self.parameters?.phase !== node.parameters.phase) return false;
  const parent = (await context.traverse.ancestors.next()).value;
  if (!phaseParentValid(node.parameters.phase, parent)) return false;
  const children: ProgramNode[] = [];
  for await (const child of context.traverse.children) children.push(child);
  return phaseChildrenErrors(node.parameters.phase, children).length === 0;
}
export function phaseAllowsChild(phase: string, type: string): boolean {
  if (['cycle','action'].includes(phase)) return type === PHASE_TYPE;
  return Object.hasOwn(PHASE_LABEL, phase) && !['approach','exit'].includes(phase) && type !== PALLET_TYPE && type !== PHASE_TYPE;
}
export async function parentPallet(context: ScriptContext | ValidationContext): Promise<PalletNode | undefined> {
  for await (const parent of context.traverse.ancestors) if (parent.type === PALLET_TYPE) return parent as PalletNode;
  return undefined;
}
