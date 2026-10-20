import { ScriptBuilder } from '@universal-robots/contribution-api';
import { buildPlan, jointHintForEvent } from '../../src/domain/index.ts';
import { motionSettings, nodeErrors, prefix } from './model.ts';
import type { PalletNode, PhaseNode } from './model.ts';
import { cursorForStartItem, itemEntryCursors } from './counters.ts';

function checkpoint(b: ScriptBuilder, root: PalletNode, pending='-1'): void {
  if (!root.parameters.recipe.rememberProgress) return;
  const n=prefix(root);
  // One list assignment commits both fields. The old integer is a display mirror.
  b.assign(root.parameters.resumeStateVariable!, `[${n}_cursor, ${pending}]`);
  b.assign(root.parameters.resumeVariable!, `${n}_cursor`);
}
function nextSelectedItem(b: ScriptBuilder, root: PalletNode): void {
  const counter=root.parameters.itemCounter.name,n=prefix(root);
  b.assign(`${n}_next_item`, `${counter} + 1`);
  b.ifCondition(`${counter} >= ${n}_item_total`);b.assign(`${n}_next_item`,'1');b.end();
  b.assign(counter,`${n}_next_item`);normalizeCounter(b,root);
  b.assign(`${n}_cursor`,`${n}_item_entries[${counter} - 1]`);
}

function normalizeCounter(b: ScriptBuilder, root: PalletNode): void {
  const counter = root.parameters.itemCounter.name, n = prefix(root);
  b.ifCondition(`${counter} != floor(${counter})`);
  b.addStatements('popup("Pallet item counter must be a whole number.", error=True, blocking=True)'); b.addStatements('halt'); b.end();
  b.ifCondition(`${counter} < 1 or ${counter} > ${n}_item_total`); b.assign(counter, '1'); b.end();
}
function seekChangedCounter(b: ScriptBuilder, root: PalletNode): void {
  const counter = root.parameters.itemCounter.name, n = prefix(root);
  b.ifCondition(`${counter} != ${n}_published_counter`);
  normalizeCounter(b, root);
  b.assign(`${n}_cursor`, `${n}_item_entries[${counter} - 1]`);
  b.assign(`${n}_pending_counter`,'-1');
  checkpoint(b, root);
  b.assign(`${n}_published_counter`, counter);
  b.end();
}

export function palletPreamble(node: PalletNode): ScriptBuilder {

    const builder = new ScriptBuilder();
    if (nodeErrors(node).length) return builder;
    const name = prefix(node);
    // ApplicationVariablesService stores values in the controller's shared
    // namespace. Import that binding without an assignment: assigning here
    // would overwrite the checkpoint on every program start.
    if (node.parameters.recipe.rememberProgress) {
      builder.addStatements(`shared ${node.parameters.resumeVariable!}`);
      builder.addStatements(`shared ${node.parameters.resumeStateVariable!}`);
      builder.ifCondition(`${node.parameters.resumeStateVariable!}[0] == -1`);
      builder.assign(node.parameters.resumeStateVariable!,`[${node.parameters.resumeVariable!}, -1]`);builder.end();
    }
    const events = buildPlan(node.parameters.recipe);
    const list = (kind: 'approach' | 'action' | 'exit') => `[${events.map(e => `p[${(node.parameters.featureFrame ? e.waypointsInFeature : e.waypoints)[kind].map(n => Number(n.toFixed(10))).join(',')}]`).join(',')}]`;
    builder.globalVariable(`${name}_approach`, list('approach'));
    builder.globalVariable(`${name}_action`, list('action'));
    builder.globalVariable(`${name}_exit`, list('exit'));
    const profiles=motionSettings(node);
    for(const phase of ['approach','action','exit'] as const){
      const qs:string[]=[],indices=events.map(event=>{
        const profile=profiles[event.kind][phase];
        if(profile.type!=='joint'||profile.qNearMode!=='taught')return -1;
        const hint=jointHintForEvent(node.parameters.recipe,event,phase).hint!;
        const literal=`[${hint.q.join(',')}]`;let index=qs.indexOf(literal);
        if(index<0){index=qs.length;qs.push(literal);}return index;
      });
      if(qs.length){builder.globalVariable(`${name}_q_${phase}`,`[${qs.join(',')}]`);builder.globalVariable(`${name}_qi_${phase}`,`[${indices.join(',')}]`);}
    }
    builder.globalVariable(`${name}_kind`, `[${events.map(e => e.kind === 'item' ? '0' : '1').join(',')}]`);
    const totalItems = events.filter(e => e.kind === 'item').length;
    const ordinals = events.map(() => 0);
    if (node.parameters.recipe.mode === 'palletize') {
      let ordinal = 1;
      for (let i = 0; i < events.length; i++) { const event = events[i]; if (event.kind === 'item') ordinal = event.itemOrdinal; ordinals[i] = ordinal; }
    } else {
      let ordinal = totalItems;
      for (let i = events.length - 1; i >= 0; i--) { const event = events[i]; if (event.kind === 'item') ordinal = event.itemOrdinal; ordinals[i] = ordinal; }
    }
    builder.globalVariable(`${name}_ordinal`, `[${ordinals.join(',')}]`);
    builder.globalVariable(node.parameters.itemCounter.name, '1');
    builder.globalVariable(node.parameters.totalCounter.name, String(totalItems));
    builder.globalVariable(`${name}_item_total`, String(totalItems));
    builder.globalVariable(`${name}_item_entries`, `[${itemEntryCursors(node.parameters.recipe).join(',')}]`);
    builder.globalVariable(`${name}_cursor`, node.parameters.recipe.rememberProgress ? `${node.parameters.resumeStateVariable!}[0]` : String(cursorForStartItem(node.parameters.recipe, node.parameters.startItem ?? 1)));
    builder.globalVariable(`${name}_pending_counter`,node.parameters.recipe.rememberProgress?`${node.parameters.resumeStateVariable!}[1]`:'-1');
    builder.globalVariable(`${name}_total`, String(events.length));
    // Publish the saved pending item before any native node preceding this root
    // can assign a different selection. Never index a corrupt checkpoint here.
    builder.ifCondition(`${name}_cursor >= 0 and ${name}_cursor < ${name}_total and ${name}_cursor == floor(${name}_cursor)`);
    builder.assign(node.parameters.itemCounter.name, `${name}_ordinal[${name}_cursor]`); builder.end();
    builder.ifCondition(`${name}_cursor == ${name}_total`); builder.assign(node.parameters.itemCounter.name, `${name}_item_total`); builder.end();
    builder.ifCondition(`${name}_cursor == ${name}_total + 1`); builder.assign(node.parameters.itemCounter.name, node.parameters.autoRepeat ? '1' : `${name}_item_total + 1`); builder.end();
    builder.ifCondition(`${name}_pending_counter != -1`);builder.assign(node.parameters.itemCounter.name,`${name}_pending_counter`);builder.end();
    builder.globalVariable(`${name}_published_counter`, node.parameters.itemCounter.name);
    return builder;
}
export function palletBefore(node: PalletNode): ScriptBuilder {

    const b = new ScriptBuilder();
    if (nodeErrors(node).length) return b;
    const n = prefix(node);
    if (node.parameters.featureFrame) b.assign(`${n}_frame`, `get_pose(${JSON.stringify(node.parameters.featureFrame)}, "base")`);
    // 0..total-1: pending event; total: after-pallet actions pending;
    // total+1: complete. A legacy dev2 total checkpoint conservatively repeats after.
    b.ifCondition(`${n}_cursor < 0 or ${n}_cursor > ${n}_total + 1 or ${n}_cursor != floor(${n}_cursor)`);
    b.addStatements('popup("Palletizing progress is outside the recipe. Reset progress before continuing.", error=True, blocking=True)');
    b.addStatements('halt'); b.end();
    b.ifCondition(`${n}_pending_counter != -1 and (${n}_pending_counter < 1 or ${n}_pending_counter != floor(${n}_pending_counter) or ${n}_cursor >= ${n}_total)`);
    b.addStatements('popup("Palletizing counter checkpoint is invalid. Choose a start item before continuing.", error=True, blocking=True)');b.addStatements('halt');b.end();
    seekChangedCounter(b, node);
    if (node.parameters.autoRepeat) {
      b.ifCondition(`${n}_cursor == ${n}_total + 1`); b.assign(`${n}_cursor`, '0');
      checkpoint(b,node);
      b.end();
    }
    b.assign(`${n}_did_item`, 'False');
    b.assign(`${n}_continue`, 'True');
    b.assign(`${n}_counter_override`,`${n}_pending_counter != -1`);
    b.assign(node.parameters.itemCounter.name, `${n}_item_total + 1`);
    b.ifCondition(`${n}_cursor == ${n}_total`); b.assign(node.parameters.itemCounter.name, `${n}_item_total`); b.end();
    b.ifCondition(`${n}_cursor < ${n}_total`); b.assign(node.parameters.itemCounter.name, `${n}_ordinal[${n}_cursor]`); b.end();
    b.ifCondition(`${n}_counter_override`);b.assign(node.parameters.itemCounter.name,`${n}_pending_counter`);b.end();
    b.assign(node.parameters.totalCounter.name, `${n}_item_total`);
    b.assign(`${n}_published_counter`, node.parameters.itemCounter.name);
    return b;
}
export function phaseBefore(node: PhaseNode, root: PalletNode | undefined): ScriptBuilder {

    const b = new ScriptBuilder();
    if (!root || nodeErrors(root).length) return b;
    const n = prefix(root);
    switch (node.parameters.phase) {
      case 'before': b.ifCondition(`${n}_cursor == 0`); break;
      case 'after': b.ifCondition(`${n}_cursor == ${n}_total`); break;
      case 'item': case 'item-prepare': case 'item-after': b.ifCondition(`${n}_kind[${n}_cursor] == 0`); break;
      case 'separator': case 'separator-prepare': case 'separator-after': b.ifCondition(`${n}_kind[${n}_cursor] == 1`); break;
      case 'approach': case 'action': case 'exit':
        const target = `${n}_${node.parameters.phase}[${n}_cursor]`;
        const position=root.parameters.featureFrame ? `pose_trans(${n}_frame, ${target})` : target;
        const profiles=motionSettings(root);
        for(const kind of ['item','separator'] as const){
          const profile=profiles[kind][node.parameters.phase];
          b.ifCondition(`${n}_kind[${n}_cursor] == ${kind==='item'?0:1}`);
          const seed=profile.qNearMode==='taught'?`${n}_q_${node.parameters.phase}.get_row(${n}_qi_${node.parameters.phase}[${n}_cursor])`:'get_actual_joint_positions()';
          const motionTarget=profile.type==='joint'?`get_inverse_kin(${position}, qnear=${seed})`:position;
          b.addStatements(`${profile.type==='joint'?'movej':'movel'}(${motionTarget}, a=${profile.acceleration}, v=${profile.speed}, r=${profile.blend})`);
          b.end();
        }
        break;
      case 'cycle':
        b.beginWhile(`${n}_cursor < ${n}_total and ${n}_continue`);
        break;
    }
    // Keep empty user action branches syntactically valid.
    if (['before', 'after', 'item', 'separator', 'item-prepare', 'separator-prepare','item-after','separator-after'].includes(node.parameters.phase)) b.addStatements('sync()');
    return b;
}
export function phaseAfter(node: PhaseNode, root: PalletNode | undefined): ScriptBuilder {


    if (!root || nodeErrors(root).length) return new ScriptBuilder();
    if (['approach', 'action', 'exit'].includes(node.parameters.phase)) return new ScriptBuilder();
    const n = prefix(root); const b = new ScriptBuilder('', 1);
    if (node.parameters.phase === 'before') seekChangedCounter(b, root);
    if (node.parameters.phase === 'cycle') {
      const counter=root.parameters.itemCounter.name;
      b.ifCondition(`${counter} != ${n}_published_counter`);b.assign(`${n}_counter_override`,'True');b.end();
      b.ifCondition(`${counter} != floor(${counter})`);
      b.addStatements('popup("Pallet item counter must be a whole number.", error=True, blocking=True)');b.addStatements('halt');b.end();
      b.ifCondition(`${counter} < 1`);b.assign(counter,'1');b.end();
      b.assign(`${n}_pending_counter`,counter);
      b.assign(`${n}_did_item`, `${n}_did_item or ${n}_kind[${n}_cursor] == 0`);
      b.incrementVariable(`${n}_cursor`);
      b.assign(root.parameters.itemCounter.name, `${n}_item_total`);
      b.assign(`${n}_continue`, 'False');
      b.ifCondition(`${n}_cursor < ${n}_total`);
      b.assign(root.parameters.itemCounter.name, `${n}_ordinal[${n}_cursor]`);
      // PS5 depalletizing removes a separator before the first item below it;
      // palletizing places it after the final item in the completed layer.
      b.assign(`${n}_continue`, root.parameters.recipe.mode === 'depalletize'
        ? `not ${n}_did_item`
        : `not ${n}_did_item or ${n}_kind[${n}_cursor] == 1`);
      b.end();
      b.ifCondition(`${n}_counter_override`);b.assign(counter,`${n}_pending_counter`);b.end();
      b.ifCondition(`not ${n}_counter_override`);b.assign(`${n}_pending_counter`,'-1');b.end();
      b.ifCondition(`not ${n}_continue and ${n}_counter_override`);
      b.ifCondition(`${counter} == ${n}_item_total`);b.assign(`${n}_cursor`,`${n}_total`);b.end();
      b.ifCondition(`${counter} != ${n}_item_total`);nextSelectedItem(b,root);b.end();
      b.assign(`${n}_pending_counter`,'-1');b.end();
      checkpoint(b,root,`${n}_pending_counter`);
      b.assign(`${n}_published_counter`, root.parameters.itemCounter.name);
    }
    if (node.parameters.phase === 'after') {
      // Commit only after every after-pallet child has returned successfully.
      // An interrupted branch is repeated on restart, like an interrupted event.
      const counter = root.parameters.itemCounter.name;
      b.assign(`${n}_after_override`, `${counter} != ${n}_item_total`);
      b.ifCondition(`${n}_after_override`);
      b.ifCondition(`${counter} != floor(${counter})`);
      b.addStatements('popup("Pallet item counter must be a whole number.", error=True, blocking=True)'); b.addStatements('halt'); b.end();
      nextSelectedItem(b, root);
      b.end();
      b.ifCondition(`not ${n}_after_override`);
      b.assign(`${n}_cursor`, `${n}_total + 1`);
      b.assign(counter, root.parameters.autoRepeat ? '1' : `${n}_item_total + 1`);
      b.end();
      b.assign(`${n}_pending_counter`,'-1');checkpoint(b,root);
      b.assign(`${n}_published_counter`, counter);
    }
    b.endBlock();
    return b.end();
}
