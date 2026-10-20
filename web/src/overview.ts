import { buildPlan, MAX_PLAN_EVENTS, validateRecipe } from '../../src/domain/index.ts';
import type { ItemEvent, Pose, Recipe } from '../../src/domain/index.ts';

export interface OverviewOptions { layerIndex?: number; eventIndex?: number; }
export interface ProjectionOptions { width?: number; height?: number; padding?: number; }
export interface TopDownProjection {
  width: number;
  height: number;
  /** The same pixels-per-metre scale applies to both axes. */
  scale: number;
  points: { x: number; y: number }[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const number = (value: number, digits = 2) => Number(value.toFixed(digits)).toLocaleString('de-DE', { maximumFractionDigits: digits });
const pixel = (value: number) => Number(value.toFixed(3));
const MAX_DRAWN_ITEMS = 160;
const MAX_LABELS = 24;

/** Project pallet-frame XY positions without changing their aspect ratio or input. */
export function projectTopDown(poses: readonly (readonly number[])[], options: ProjectionOptions = {}): TopDownProjection {
  const { width = 640, height = 320, padding = 36 } = options;
  if (![width, height, padding].every(Number.isFinite) || padding < 0 || width <= padding * 2 || height <= padding * 2) throw new RangeError('Invalid projection dimensions');
  if (poses.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) throw new RangeError('Projection requires finite XY coordinates');
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poses) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  if (!poses.length) minX = maxX = minY = maxY = 0;
  const scale = Math.min((width - padding * 2) / Math.max(maxX - minX, 0.000001), (height - padding * 2) / Math.max(maxY - minY, 0.000001));
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
  return { width, height, scale, bounds: { minX, maxX, minY, maxY }, points: poses.map(p => ({ x: width / 2 + (p[0] - midX) * scale, y: height / 2 - (p[1] - midY) * scale })) };
}

/** Include both ends and the selected item while keeping a deterministic bounded sample. */
function sampleIndexes(count: number, selected: number): number[] {
  if (count <= MAX_DRAWN_ITEMS) return Array.from({ length: count }, (_, i) => i);
  const indexes = new Set<number>([selected]);
  for (let i = 0; i < MAX_DRAWN_ITEMS - 1; i++) indexes.add(Math.round(i * (count - 1) / (MAX_DRAWN_ITEMS - 2)));
  return [...indexes].sort((a, b) => a - b);
}

interface LabelBox { x: number; y: number; width: number; height: number; }
function labelBoxes(items: readonly ItemEvent[], points: TopDownProjection['points'], drawn: readonly number[], selected: number, width: number, height: number): Map<number, LabelBox> {
  const boxes = new Map<number, LabelBox>();
  const priorities = [...new Set([selected, 0, items.length - 1, ...drawn])];
  for (const index of priorities) {
    if (!drawn.includes(index) || boxes.size >= MAX_LABELS) continue;
    const p = points[index], boxWidth = Math.max(30, String(items[index].itemOrdinal).length * 10 + 12);
    for (const y of [p.y - 35, p.y + 15]) {
      const box = { x: p.x - boxWidth / 2, y, width: boxWidth, height: 25 };
      if (box.x < 3 || box.x + box.width > width - 3 || box.y < 3 || box.y + box.height > height - 3) continue;
      if ([...boxes.values()].some(b => box.x < b.x + b.width + 6 && box.x + box.width + 6 > b.x && box.y < b.y + b.height + 4 && box.y + box.height + 4 > b.y)) continue;
      boxes.set(index, box); break;
    }
  }
  return boxes;
}

function orderArrows(points: TopDownProjection['points']): string {
  if (points.length > MAX_LABELS) return '';
  return points.slice(1).map((p, i) => {
    const previous = points[i], dx = p.x - previous.x, dy = p.y - previous.y, length = Math.hypot(dx, dy);
    if (length < 42) return '';
    const ux = dx / length, uy = dy / length, start = { x: previous.x + ux * 13, y: previous.y + uy * 13 }, end = { x: p.x - ux * 17, y: p.y - uy * 17 };
    return `<g class="pv-order" aria-hidden="true"><line x1="${pixel(start.x)}" y1="${pixel(start.y)}" x2="${pixel(end.x)}" y2="${pixel(end.y)}"/><path d="M ${pixel(end.x)} ${pixel(end.y)} l ${pixel(-ux * 7 - uy * 4)} ${pixel(-uy * 7 + ux * 4)} l ${pixel(uy * 8)} ${pixel(-ux * 8)} Z"/></g>`;
  }).join('');
}

function visibleLayers(count: number, selected: number): number[] {
  const start = Math.min(Math.max(0, selected - 2), Math.max(0, count - 5));
  return [...new Set([0, ...Array.from({ length: Math.min(5, count) }, (_, i) => start + i), count - 1])].sort((a, b) => b - a);
}

function poseDetail(pose: Pose): string {
  return `<dl class="pv-coordinates">${['X', 'Y', 'Z'].map((axis, i) => `<div><dt>${axis}</dt><dd>${number(pose[i] * 1000)} <span>mm</span></dd></div>`).join('')}</dl><details class="pv-orientation"><summary>Orientierung</summary><p>${['Rx', 'Ry', 'Rz'].map((axis, i) => `${axis} ${number(pose[i + 3], 5)} rad`).join(' · ')} · Rotationsvektor</p></details>`;
}

const emptyOverview = () => '<section class="pv-overview"><div class="pv-empty"><h3>Palettenübersicht</h3><p>Vorschau verfügbar, sobald Muster und Lagen gültig sind.</p><p class="pv-caption">Die Eingaben bleiben erhalten.</p></div></section>';

/** A read-only recipe view. All data-view-* interactions are handled by the presenter. */
export function renderOverview(recipe: Recipe, options: OverviewOptions = {}): string {
  try {
    if (validateRecipe(recipe).length) return emptyOverview();
    const events = buildPlan(recipe);
    if (!events.length || events.length > MAX_PLAN_EVENTS) return emptyOverview();
    const allItems = events.filter((event): event is ItemEvent => event.kind === 'item');
    const requestedItem = allItems.find(event => event.eventIndex === options.eventIndex);
    const layerIndex = Number.isSafeInteger(options.layerIndex) && options.layerIndex! >= 0 && options.layerIndex! < recipe.layers.length ? options.layerIndex! : (requestedItem?.layerIndex ?? allItems[0].layerIndex);
    const items = allItems.filter(event => event.layerIndex === layerIndex);
    const selected = Math.max(0, items.findIndex(event => event.eventIndex === options.eventIndex));
    const selectedItem = items[selected];
    if (!selectedItem) return emptyOverview();
    // Match the actual narrow presenter pane; a desktop-sized viewBox made labels
    // illegible when the enclosing PolyScope dialog still had a wide viewport.
    const projection = projectTopDown(items.map(event => event.poseInFeature), { width: 320, height: 200, padding: 40 });
    const drawn = sampleIndexes(items.length, selected);
    const labels = labelBoxes(items, projection.points, drawn, selected, projection.width, projection.height);
    const truncated = drawn.length < items.length;
    const pattern = recipe.patterns.find(p => p.id === recipe.layers[layerIndex].patternId)!;
    // Paint the selection last so coincident positions cannot cover its marker.
    const paintOrder = [...drawn.filter(index => index !== selected), selected];
    const markers = paintOrder.map(index => {
      const event = items[index], p = projection.points[index], box = labels.get(index), active = index === selected;
      return `<g class="pv-item${active ? ' pv-selected' : ''}" data-view-item="${event.eventIndex}" role="button" tabindex="${items.length <= MAX_LABELS || active ? 0 : -1}" aria-pressed="${active}" aria-label="Teil ${event.itemOrdinal}, Lage ${layerIndex + 1} auswählen"><circle class="pv-hit" cx="${pixel(p.x)}" cy="${pixel(p.y)}" r="24"/><circle class="pv-dot" cx="${pixel(p.x)}" cy="${pixel(p.y)}" r="${active ? 11 : 8}"/>${box ? `<g class="pv-label" aria-hidden="true"><rect x="${pixel(box.x)}" y="${pixel(box.y)}" width="${box.width}" height="${box.height}" rx="3"/><text x="${pixel(p.x)}" y="${pixel(box.y + 19)}">${event.itemOrdinal}</text></g>` : ''}</g>`;
    }).join('');
    const layerIndexes = visibleLayers(recipe.layers.length, layerIndex);
    const stack = layerIndexes.map((index, i) => {
      const layer = recipe.layers[index], name = recipe.patterns.find(p => p.id === layer.patternId)!.name;
      const gap = i > 0 && layerIndexes[i - 1] - index > 1 ? `<div class="pv-layer-gap">${layerIndexes[i - 1] - index - 1} weitere Lagen</div>` : '';
      return `${gap}<button type="button" class="pv-layer${index === layerIndex ? ' pv-active-layer' : ''}" data-view-layer="${index}" aria-pressed="${index === layerIndex}" aria-label="Lage ${index + 1}, ${esc(name)}${layer.separatorAfter ? ', mit Zwischenlage darüber' : ''}" title="${esc(name)}">${layer.separatorAfter ? '<span class="pv-sheet">Zwischenlage</span>' : ''}<span class="pv-layer-heading">Lage ${index + 1}</span><span class="pv-layer-name">${esc(name)}</span></button>`;
    }).join('');
    const previous = items[selected - 1], next = items[selected + 1];
    return `<section class="pv-overview" aria-label="Palettenübersicht"><div class="pv-overview-heading"><h3>Palettenübersicht</h3><span>${recipe.mode === 'palletize' ? 'Palettieren · unten → oben' : 'Depalettieren · oben → unten'}</span></div><div class="pv-stats" aria-label="Palettenumfang"><span><strong>${number(allItems.length, 0)}</strong> Teile</span><span><strong>${number(recipe.layers.length, 0)}</strong> Lagen</span><span><strong>${number(events.length - allItems.length, 0)}</strong> Zwischenlagen</span></div><div class="pv-layout"><div class="pv-topdown"><div class="pv-view-heading"><strong>Lage ${layerIndex + 1}</strong><span>${esc(pattern.name)} · ${number(items.length, 0)} Teile</span></div><svg class="pv-canvas" viewBox="0 0 ${projection.width} ${projection.height}" role="group" aria-label="Draufsicht auf Lage ${layerIndex + 1}; Nummern zeigen die Teilefolge"><g class="pv-axes" aria-hidden="true"><path d="M 18 18 V 44 H 44"/><text x="48" y="48">+X</text><text x="8" y="13">+Y</text></g>${orderArrows(projection.points)}${markers}</svg><p class="pv-caption">Nummern = Teilefolge${truncated ? ` · ${drawn.length} von ${items.length} Positionen dargestellt` : ''}${labels.size < drawn.length ? ' · Nummern teilweise ausgeblendet' : ''}.</p><div class="pv-selection" role="status" aria-live="polite"><div class="pv-selection-heading"><strong>Teil ${selectedItem.itemOrdinal} · Lage ${layerIndex + 1}</strong><span>${selected + 1} von ${items.length} in dieser Lage</span></div>${poseDetail(selectedItem.poseInFeature)}</div><div class="pv-item-navigation"><button type="button" ${previous ? `data-view-item="${previous.eventIndex}"` : 'disabled'} aria-label="Vorheriges Teil in dieser Lage">← Vorheriges</button><button type="button" ${next ? `data-view-item="${next.eventIndex}"` : 'disabled'} aria-label="Nächstes Teil in dieser Lage">Nächstes →</button></div></div><aside class="pv-stack" aria-label="Lagen auswählen"><h4>Lagenstapel</h4><p class="pv-caption">Oben</p>${stack}<p class="pv-caption">Unten</p></aside></div><p class="pv-limit">Palettenbezug · Reihenfolge, keine Bewegungsbahn.</p></section>`;
  } catch {
    return emptyOverview();
  }
}

export const OVERVIEW_CSS = `
.pv-overview{container-type:inline-size;container-name:pv-panel;min-width:0;padding:0;background:#fff;color:#263942}
.pv-overview-heading,.pv-view-heading,.pv-selection-heading{display:flex;justify-content:space-between;gap:6px;align-items:baseline;flex-wrap:wrap}
.pv-overview-heading h3{margin:0;font-size:17px}
.pv-overview-heading>span,.pv-view-heading>span,.pv-selection-heading>span{font-size:12px;color:#526974;overflow-wrap:anywhere}
.pv-stats{display:flex;gap:15px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid #e1e6e9;margin-bottom:9px}
.pv-stats span{font-size:13px}.pv-stats strong{font-size:17px;font-weight:600}
.pv-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:11px}.pv-topdown{min-width:0;display:contents}.pv-view-heading{grid-row:1}.pv-canvas{grid-row:2}.pv-topdown>.pv-caption{grid-row:3}.pv-stack{grid-row:4}.pv-selection{grid-row:5}.pv-item-navigation{grid-row:6}.pv-view-heading{margin-bottom:6px}
.pv-canvas{display:block;width:100%;height:200px;min-height:0;background:#f5f7f8;border:1px solid #dde4e8;border-radius:5px}
.pv-axes path{fill:none;stroke:#82939d;stroke-width:1}.pv-axes text{fill:#627680;font-size:12px}
.pv-order line{stroke:#b4c2ca;stroke-width:1.5}.pv-order path{fill:#b4c2ca}.pv-hit{fill:transparent;stroke:none}
.pv-item{cursor:pointer;outline:none}.pv-dot{fill:#577e91;stroke:#fff;stroke-width:2}.pv-selected .pv-dot{fill:#167ca5;stroke:#144d64;stroke-width:2}.pv-item:focus-visible .pv-dot{stroke:#005b84;stroke-width:4}
.pv-label rect{fill:#fff;stroke:#dde4e8;stroke-width:.75}.pv-label text{fill:#344e5b;text-anchor:middle;font:600 18px Arial,sans-serif}.pv-selected .pv-label rect{fill:#e6f2f7;stroke:#167ca5}
.pv-caption{font-size:12px;line-height:1.35;color:#536a75;margin:5px 0}
.pv-selection{padding:8px 10px;background:#f3f6f7;border:1px solid #dce4e8;border-radius:5px;margin-top:7px}
.pv-selection-heading>strong{font-size:14px}.pv-coordinates{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:6px 0 0}.pv-coordinates dt{font-size:12px;color:#526974}.pv-coordinates dd{font-size:15px;margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.pv-coordinates dd span{font-size:12px;color:#526974}
.pv-orientation{margin:4px 0 0;border:0;padding:0;font-size:12px;color:#526974}.pv-orientation summary{cursor:pointer;min-height:28px;padding:3px 0;font-size:12px}.pv-orientation p{margin:3px 0;font-size:12px;overflow-wrap:anywhere}
.pv-item-navigation{display:flex;justify-content:space-between;gap:8px;margin-top:7px}.pv-item-navigation button,.pv-layer{min-height:44px;border:1px solid #bccbd3;background:#fff;border-radius:5px;color:#263942;font:inherit;cursor:pointer}.pv-item-navigation button{padding:8px 12px;font-size:13px}.pv-item-navigation button:disabled{opacity:.45;cursor:default}
.pv-stack{display:grid;grid-template-columns:repeat(auto-fit,minmax(78px,1fr));gap:5px;min-width:0}.pv-stack h4{grid-column:1/-1;font-size:12px;margin:0}.pv-stack>.pv-caption{display:none}
.pv-layer{position:relative;width:100%;min-width:0;display:grid;gap:2px;text-align:left;padding:7px 8px;margin:0;font-size:13px;overflow:hidden}.pv-layer:hover,.pv-item-navigation button:hover:enabled{background:#f1f6f8}.pv-active-layer{border-color:#197da5;background:#e9f3f7;box-shadow:inset 3px 0 #197da5}.pv-layer-heading{font-weight:600}.pv-layer-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#536a75}
.pv-sheet{display:block;margin:-3px -4px 2px;padding:1px 4px;border-top:3px solid #bc9b4e;background:#faf4e7;font-size:10px;color:#775e29}.pv-layer-gap{font-size:11px;text-align:center;color:#627680;padding:3px 0;align-self:center}
.pv-layer:focus-visible,.pv-item-navigation button:focus-visible,.pv-orientation summary:focus-visible{outline:3px solid #65b0d0;outline-offset:2px}
.pv-limit{font-size:12px;color:#627680;margin:8px 0 0}.pv-empty h3{margin:0 0 8px;font-size:17px}.pv-empty p{font-size:13px;margin:5px 0}
@container pv-panel (min-width:560px){.pv-topdown{display:block}.pv-stack{grid-row:auto}.pv-layout{grid-template-columns:minmax(0,1fr) 104px}.pv-stack{display:block}.pv-stack h4{margin-bottom:6px}.pv-stack>.pv-caption{display:block;text-align:center}.pv-layer{margin:4px 0}}
`;
