import type { ProgramTreeService, SubtreeNode, VariableDeclaration } from '@universal-robots/contribution-api';
import { id, PALLET_TYPE } from './model.ts';
import type { PalletNode } from './model.ts';

type Counters = Pick<PalletNode['parameters'], 'itemCounter' | 'totalCounter'>;
type TreeService = Pick<ProgramTreeService, 'getProgramNodeById' | 'getSubtreeContextFromProgramNodeById' | 'updateSubTreeNode'>;

/** Copy runs before PolyScope replaces symbol declarations. Store only plain IDs. */
export function recordPalletCopy<T extends PalletNode>(source: T): T {
  if (source.parameters.pendingRemap !== undefined) throw new Error('Vor erneutem Kopieren zuerst den Assistenten der eingefügten Palette öffnen.');
  const node = structuredClone(source);
  node.parameters.copySourceCounters = { oldItemId: source.parameters.itemCounter.id, oldTotalId: source.parameters.totalCounter.id };
  return node;
}

/**
 * Map only typed references to this pallet's two counters in the copied subtree.
 * Declarations, foreign references, ordinary IDs and raw script text are preserved.
 */
export function remapCounterReferences<T>(source: T, mapping: ReadonlyMap<string, string>): T {
  const result = structuredClone(source);
  const pending: unknown[] = [result];
  const visited = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    const object = value as Record<string, unknown>;
    if (object._IDENTIFIER === 'VariableDeclaration') continue;
    if (object._IDENTIFIER === 'VariableReference') {
      if (typeof object.id === 'string' && mapping.has(object.id)) object.id = mapping.get(object.id)!;
      continue;
    }
    pending.push(...Object.values(object));
  }
  return result;
}

export function preparePastedPallet<T extends PalletNode>(source: T, counters: Counters): T {
  const previous = source.parameters;
  const validDeclaration = (value: VariableDeclaration) => value?._IDENTIFIER === 'VariableDeclaration'
    && typeof value.id === 'string' && value.id.length > 0 && value.valueType === 'integer';
  if (![previous.itemCounter, previous.totalCounter, counters.itemCounter, counters.totalCounter].every(validDeclaration)
    || previous.itemCounter.id === previous.totalCounter.id || counters.itemCounter.id === counters.totalCounter.id) {
    throw new Error('Palettierknoten kann ohne zwei eindeutige Zählerdeklarationen nicht kopiert werden.');
  }
  // The observed SDK paste hook receives a flat node BEFORE insertion; children
  // cannot be repaired here. Its declarations have already been copied by SDK.
  const node = structuredClone(source);
  node.parameters.pendingRemap = structuredClone(previous.copySourceCounters ?? { oldItemId: '', oldTotalId: '' });
  delete node.parameters.copySourceCounters;
  node.parameters.recipe.id = id();
  node.parameters.runtimeId = id();
  node.parameters.itemCounter = structuredClone(counters.itemCounter);
  node.parameters.totalCounter = structuredClone(counters.totalCounter);
  node.parameters.approvedRevision = undefined;
  node.parameters.approvedPlannerVersion = undefined;
  node.parameters.resumeVariable = undefined;
  node.parameters.resumeStateVariable = undefined;
  node.parameters.resumeRevision = undefined;
  node.parameters.resumePlannerVersion = undefined;
  node.parameters.startItem = 1;
  return node;
}

/** Finish a pasted, invalid node only after it exists in the program tree. */
export async function remapPastedSubtree(service: TreeService, rootId: string): Promise<PalletNode> {
  const readRoot = async () => {
    const node = await service.getProgramNodeById(rootId);
    if (node?.type !== PALLET_TYPE || !node.parameters) throw new Error('Eingefügter Palettierknoten ist nicht verfügbar.');
    return structuredClone(node) as PalletNode;
  };
  const root = await readRoot(), pending = root.parameters.pendingRemap;
  if (pending === undefined) return root;
  if (!pending || typeof pending.oldItemId !== 'string' || !pending.oldItemId || typeof pending.oldTotalId !== 'string' || !pending.oldTotalId || pending.oldItemId === pending.oldTotalId) {
    throw new Error('Quellzähler fehlen. Quellpalette mit der aktuellen URCap erneut kopieren.');
  }
  const pairs = [[pending.oldItemId, root.parameters.itemCounter.id], [pending.oldTotalId, root.parameters.totalCounter.id]];
  if (new Set(pairs.map(pair => pair[1])).size !== 2 || pairs.some(pair => !pair[1])) throw new Error('Die Zähler besitzen keine eindeutigen Kennungen.');
  // Renaming may replace only one declaration; the other reference is a no-op.
  const mapping = new Map(pairs.filter(([from, to]) => from !== to).map(([from, to]) => [from, to]));
  const descendants = async (): Promise<Readonly<SubtreeNode>[]> => {
    const context = await service.getSubtreeContextFromProgramNodeById(rootId);
    if (!context?.depthFirst) throw new Error('Der kopierte Teilbaum ist noch nicht verfügbar. Assistent erneut öffnen.');
    const entries: Readonly<SubtreeNode>[] = [], ids = new Set<string>();
    for await (const entry of context.depthFirst) {
      if (entry.id === rootId) continue;
      if (!entry.id || ids.has(entry.id) || entries.length >= 2000) throw new Error('Kopierter Teilbaum ist ungültig oder zu groß.');
      ids.add(entry.id); entries.push(entry);
    }
    if (entries.length < 12) throw new Error('Der vollständige Paletten-Teilbaum ist noch nicht verfügbar.');
    return entries;
  };
  for (const entry of await descendants()) {
    const current = await service.getProgramNodeById(entry.id);
    if (!current) throw new Error('Ein kopierter Benutzerknoten wurde während der Zuordnung entfernt.');
    const updated = remapCounterReferences(current, mapping);
    if (JSON.stringify(updated) !== JSON.stringify(current)) await service.updateSubTreeNode({ id: entry.id, node: updated });
  }
  // Re-read the tree. Never clear the blocking marker if any update failed or
  // a remaining/new child still refers to either old owned counter.
  for (const entry of await descendants()) {
    if (JSON.stringify(remapCounterReferences(entry.node, mapping)) !== JSON.stringify(entry.node)) throw new Error('Zählerreferenzen konnten nicht vollständig zugeordnet werden.');
  }
  const refreshed = await readRoot();
  if (refreshed.parameters.runtimeId !== root.parameters.runtimeId
    || JSON.stringify(refreshed.parameters.pendingRemap) !== JSON.stringify(pending)
    || refreshed.parameters.itemCounter.id !== root.parameters.itemCounter.id
    || refreshed.parameters.totalCounter.id !== root.parameters.totalCounter.id) throw new Error('Palettierknoten wurde während der Zuordnung geändert.');
  delete refreshed.parameters.pendingRemap;
  await service.updateSubTreeNode({ id: rootId, node: refreshed });
  const confirmed = await readRoot();
  if (confirmed.parameters.pendingRemap !== undefined) throw new Error('Zählerzuordnung wurde nicht gespeichert.');
  return confirmed;
}
