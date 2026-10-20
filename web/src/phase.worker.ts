import { phaseBefore, phaseAfter } from './script.ts';
import { registerProgramBehavior } from '@universal-robots/contribution-api';
import type { ProgramBehaviors } from '@universal-robots/contribution-api';
import { PALLET_TYPE, parentPallet, phaseAllowsChild, phaseValidInTree, PHASE_LABEL, PHASE_TYPE } from './model.ts';
import type { PhaseNode } from './model.ts';
import { NODE_VERSION } from './model.ts';
import { upgradePhase } from './upgrade.ts';

const behaviors: ProgramBehaviors<PhaseNode> = {
  factory: () => ({ type: PHASE_TYPE, version: NODE_VERSION, allowsChildren: true, parameters: { phase: 'item' } }),
  programNodeLabel: node => PHASE_LABEL[node.parameters?.phase] ?? 'Ungültiger Ablaufknoten',
  validator: async (node, context) => ({ isValid: await phaseValidInTree(node, context) }),
  allowedInContext: async context => { const parent = (await context.traverse.ancestors.next()).value; return !!parent && (parent.type === PALLET_TYPE || (parent.type === PHASE_TYPE && ['cycle','action'].includes(parent.parameters?.phase))); },
  allowsChild: (node, type) => phaseAllowsChild(node.parameters?.phase ?? '', type),
  generateCodeBeforeChildren: async (node, context) => phaseBefore(node, await parentPallet(context)),
  generateCodeAfterChildren: async (node, context) => phaseAfter(node, await parentPallet(context)),
  upgradeNode: upgradePhase,
};
registerProgramBehavior(behaviors);
