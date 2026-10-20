import { NODE_VERSION, CURRENT_PLANNER_VERSION } from './model.ts';
import type { PalletNode, PhaseNode } from './model.ts';
import type { Recipe } from '../../src/domain/index.ts';

/** Preserve legacy target order while adopting PS5's Rows=C1→C2 convention. */
export function migrateRecipe(recipe:Recipe):Recipe {
  const result=structuredClone(recipe);
  if(result.plannerVersion!==3){
    result.patterns=result.patterns.map(p=>p.kind==='grid'?{...p,rows:p.columns,columns:p.rows}:p);
    result.plannerVersion=3;
  }
  return result;
}

/** PSX adopts the result only when its version differs from the unmodified input. */
export function upgradePallet(node: PalletNode): PalletNode {
  if (node.version !== '1.0.0') return node;
  const upgraded = structuredClone(node);
  upgraded.version = NODE_VERSION;
  if (upgraded.parameters) {
    const recipe=upgraded.parameters.recipe;
    if(recipe&&Array.isArray(recipe.patterns)){
      upgraded.parameters.recipe=migrateRecipe(recipe);
      // The axis-name swap preserves the whole event sequence. Legacy reverse-all
      // depallet checkpoints still require reset; planner2 checkpoints do not.
      if(recipe.mode!=='depalletize'||(upgraded.parameters.resumePlannerVersion??0)>=2)upgraded.parameters.resumePlannerVersion=CURRENT_PLANNER_VERSION;
    }
    upgraded.parameters.startItem ??= 1;
    if(upgraded.parameters.motion)for(const kind of ['item','separator'] as const)for(const phase of ['approach','action','exit'] as const){const profile=upgraded.parameters.motion[kind]?.[phase];if(profile?.type==='joint')profile.qNearMode??='current';}
    // Native counter assignments now select an item. Review that behavior, but
    // preserve the exact event checkpoint and its recipe revision/binding.
    upgraded.parameters.approvedRevision = undefined;
  }
  return upgraded;
}

export function upgradePhase(node: PhaseNode): PhaseNode {
  return node.version === '1.0.0' ? { ...node, version: NODE_VERSION } : node;
}
