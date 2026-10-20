import { buildPlan } from '../../src/domain/index.ts';
import type { Recipe } from '../../src/domain/index.ts';

/** A start item includes its leading separator in depalletizing mode. */
export function itemEntryCursors(recipe: Recipe): number[] {
  const events = buildPlan(recipe);
  return events.filter(event => event.kind === 'item').map(event => {
    const previous = events[event.eventIndex - 1];
    return recipe.mode === 'depalletize' && previous?.kind === 'separator' ? previous.eventIndex : event.eventIndex;
  });
}

export function cursorForStartItem(recipe: Recipe, item: number): number {
  const entries = itemEntryCursors(recipe);
  if (!Number.isSafeInteger(item) || item < 1 || item > entries.length) throw new RangeError(`Startteil muss zwischen 1 und ${entries.length} liegen.`);
  return entries[item - 1];
}
