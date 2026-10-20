import { ProgramBehaviorAPI, registerProgramBehavior } from '@universal-robots/contribution-api';
import type { ProgramBehaviors } from '@universal-robots/contribution-api';
import { palletPreamble, palletBefore } from './script.ts';
import { featurePoseFromFrames, readFrameSnapshot } from './frames.ts';
import { preparePastedPallet, recordPalletCopy } from './paste.ts';
import { upgradePallet } from './upgrade.ts';
import { jointRuntimeErrors, requiresTaughtJoints } from './joints.ts';
import { createSimplePallet, nodeErrors, PALLET_TYPE, phaseChildrenErrors, PHASE_TYPE } from './model.ts';
import type { PalletNode } from './model.ts';

const behaviors: ProgramBehaviors<PalletNode> = {
  factory: async () => { const node = createSimplePallet(); const api = new ProgramBehaviorAPI(self); node.parameters.itemCounter = await api.variableService.createVariable('PalletItem', 'integer'); node.parameters.totalCounter = await api.variableService.createVariable('PalletTotal', 'integer'); return node; },
  programNodeLabel: node => node.parameters?.recipe ? `${node.parameters.recipe.mode === 'palletize' ? 'Palettieren' : 'Depalettieren'} · ${node.parameters.recipe.name}` : 'Ungültiges Palettenrezept',
  validator: async (node, context) => {
    const errors = nodeErrors(node);
    const children = []; for await (const child of context.traverse.children) children.push(child);
    errors.push(...phaseChildrenErrors(PALLET_TYPE, children));
    if (!errors.length) {
      const api=new ProgramBehaviorAPI(self);
      if(requiresTaughtJoints(node))try{const [robotType,position]=await Promise.all([api.robotInfoService.getRobotType(),api.robotPositionService.getCurrentPosition()]);if(!position)throw new Error('Aktueller TCP nicht verfügbar.');errors.push(...jointRuntimeErrors(node,robotType,position.tcp));}catch(error){errors.push(`Gelenkhinweise konnten nicht geprüft werden: ${String(error)}`);}
      if(node.parameters.featureFrame)try{featurePoseFromFrames(await readFrameSnapshot(api.framesService),node.parameters.featureFrame);}catch(error){errors.push(`Palettenframe nicht verfügbar: ${String(error)}`);}
      const instances = await api.programTreeService.getContributedNodeInstancesForURCap();
      const roots = instances.filter(n => n.node.type === PALLET_TYPE).map(n => n.node as PalletNode);
      if (roots.filter(n => n.parameters?.runtimeId === node.parameters.runtimeId).length > 1) errors.push('Doppelte Palettier-Instanzkennung. Knoten neu einfügen.');
      const ownNames=[node.parameters.itemCounter.name,node.parameters.totalCounter.name];
      if(roots.some(n=>n.parameters?.runtimeId!==node.parameters.runtimeId&&[n.parameters?.itemCounter?.name,n.parameters?.totalCounter?.name].some(name=>ownNames.includes(name)))) errors.push('Zählername wird bereits von einem anderen Palettierknoten verwendet.');
    }
    return { isValid: errors.length === 0, errorMessageKey: errors[0] };
  },
  allowsChild: (_, type) => type === PHASE_TYPE,
  generateCodePreamble: palletPreamble,
  generateCodeBeforeChildren: palletBefore,
  upgradeNode: upgradePallet,
  onLifeCycleHook: async (event, data) => {
    if (event === 'copy') return { ...data, node: recordPalletCopy(data.node as PalletNode) };
    if (event !== 'paste') return;
    const api = new ProgramBehaviorAPI(self);
    const itemCounter = await api.variableService.createVariable('PalletItem', 'integer');
    const totalCounter = await api.variableService.createVariable('PalletTotal', 'integer');
    const node = preparePastedPallet(data.node as PalletNode, { itemCounter, totalCounter });
    return { ...data, node };
  },
};
registerProgramBehavior(behaviors);
