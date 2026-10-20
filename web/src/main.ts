import { ApplicationVariablesService, FramesService } from '@universal-robots/contribution-api';
import type { Frame, ProgramPresenterAPI, ProgramPresenter, Waypoint, WebComponentDialogAPI } from '@universal-robots/contribution-api';
import { addIrregularPoint, clearJointHint, composePoses, createDefaultRecipe, duplicatePatternHints, getJointHint, patternItemCount, reconcileTeaching, remapTeachingForImport, removeIrregularPoint, removePatternHints, setJointHint, toFeaturePose, validateRecipe } from '../../src/domain/index.ts';
import type { Pattern, Pose, Recipe, WaypointTemplate } from '../../src/domain/index.ts';
import { createPallet, createSimplePallet, CURRENT_PLANNER_VERSION, plannerApproved, id, motionSettings, nodeErrors, PALLET_TYPE, PHASE_LABEL, PHASE_TYPE, prefix, requiredTeachKeys, synchronizeReference, validIdentifier } from './model.ts';
import type { MotionKind, MotionPhase, PalletNode, PhaseNode } from './model.ts';
import { featurePoseFromFrames, readFrameSnapshot } from './frames.ts';
import { remapPastedSubtree } from './paste.ts';
import { cursorForStartItem } from './counters.ts';
import { configureProgress } from './progress.ts';
import { migrateRecipe } from './upgrade.ts';
import { CSS } from './styles.ts';
import { renderOverview, OVERVIEW_CSS } from './overview.ts';
import { homeView, recipeView, patternView, layersView, simpleMotionView, reviewView, viewTitles } from './views.ts';
import type { ViewContext } from './views.ts';
import { synchronizeSetup, reviewRectangleSetup, reviewVerticalSetup, setRectangleSetup, setVerticalSetup, clearVerticalSetup } from './setup.ts';
import { assertTeachTcp, atTarget, hintCompatibility, jointObject, lockedTeachOptions, measuredHint } from './joints.ts';

const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clone = <T>(value: T): T => structuredClone(value);

const labels = ['X · mm', 'Y · mm', 'Z · mm', 'Rx · rad', 'Ry · rad', 'Rz · rad'];
const poseValue = (p: Pose, i: number) => Number((p[i] * (i < 3 ? 1000 : 1)).toFixed(5));
const ZERO: Pose = [0, 0, 0, 0, 0, 0];

interface WizardData { node: PalletNode; resetProgress?: boolean; }
const WIZARD_TAG = 'hk-palletizing-wizard';
class PalletWizard extends HTMLElement {
  private node?: PalletNode;
  private api?: WebComponentDialogAPI;
  private resetRequested = false;
  private frames: Frame[] = [];
  private frameService?: FramesService;
  private step = -1;
  private advanced = false;
  private activePose = "";
  private viewLayer = 0;
  private viewEvent?: number;
  private requestedFrames = false;
  private renderedStep = -2;
  private renderedAdvanced = false;
  private patternIndex = 0;
  private notice = '';
  private busy = false;
  private shadow = this.attachShadow({ mode: 'open' });
  get inputData(): WizardData | undefined { return this.node ? {node:this.node,resetProgress:this.resetRequested} : undefined; }
  set inputData(value: WizardData | undefined) { this.node = value ? clone(value.node) : undefined; this.resetRequested = value?.resetProgress ?? false; this.render(); this.emitDraft(); }
  get presenterApi(): WebComponentDialogAPI | undefined { return this.api; }
  set presenterApi(value: WebComponentDialogAPI | undefined) { this.api = value; this.frameService=value?new FramesService(value.robotMoveService.communicationChannel):undefined;this.render();if(value&&!this.requestedFrames){this.requestedFrames=true;void this.readFrames().then(frames=>{this.frames=frames;this.render();}).catch(()=>{this.requestedFrames=false;});} }
  connectedCallback() { this.render(); this.emitDraft(); }
  private emitDraft() { if(this.node){this.dispatchEvent(new CustomEvent('outputDataChange',{detail:clone(this.inputData)}));this.dispatchEvent(new CustomEvent('canSave',{detail:true}));} }
  private async save(change: (node: PalletNode) => void, geometry = true, rerender = true) {
    if (!this.node || this.busy) return;
    let next = clone(this.node); change(next);
    next.parameters.recipe=reconcileTeaching(this.node.parameters.recipe,next.parameters.recipe);
    synchronizeReference(next);
    if(next.parameters.recipe.id===this.node.parameters.recipe.id){
      if(JSON.stringify(next.parameters.referenceSelection)!==JSON.stringify(this.node.parameters.referenceSelection)||next.parameters.recipe.waypoints.reference.some((v,i)=>v!==this.node!.parameters.recipe.waypoints.reference[i]))for(const phase of ['approach','action','exit']){next.parameters.taught[phase]=false;next.parameters.recipe=clearJointHint(next.parameters.recipe,phase);}
      if(next.parameters.recipe.separator?.waypoints.reference.some((v,i)=>v!==this.node!.parameters.recipe.separator?.waypoints.reference[i]))for(const phase of ['approach','action','exit']){next.parameters.taught[`separator.${phase}`]=false;next.parameters.recipe=clearJointHint(next.parameters.recipe,`separator.${phase}`);}
    }
    next.parameters.recipe=reconcileTeaching(this.node.parameters.recipe,next.parameters.recipe);
    const synchronized=synchronizeSetup(next);next=synchronized.node;
    if (geometry || synchronized.geometryChanged) { next.parameters.recipe.revision++; next.parameters.approvedRevision = undefined; next.parameters.approvedPlannerVersion = undefined; }
    this.busy = true;
    try {
      this.node = next; this.emitDraft(); this.notice = geometry ? 'Entwurf geändert. Rezept erneut prüfen; mit „Übernehmen“ speichern.' : 'Entwurf aktualisiert. Mit „Übernehmen“ speichern.';
    } catch (error) { this.notice = `Speichern fehlgeschlagen: ${String(error)}`; }
    finally { this.busy = false; this.render(); }
  }
  private input(label: string, field: string, value: string | number, type = 'number', extra = '') {
    return `<label class="field">${esc(label)}<input data-field="${esc(field)}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  }
  private poseCard(key: string, title: string, pose: Pose) {
    const taught = this.node!.parameters.taught[key]===true;
    const hint=getJointHint(this.node!.parameters.recipe,key);
    const linked=key==='reference'&&!!this.node!.parameters.referenceSelection;
    if(this.activePose!==key)return `<div data-pose-key="${esc(key)}"><button class="pose-choice" data-focus-pose="${esc(key)}"><span>${esc(title)}</span><span class="status ${taught?'ok':''}">${taught?'Geprüft':'Einlernen'}</span></button></div>`;
    return `<section class="pose" data-pose-key="${esc(key)}"><div class="pose-title"><h4>${esc(title)}</h4><span class="status ${taught?'ok':''}">${taught?'Geprüft':'Offen'}</span></div>${linked?'<p class="small muted">Aus dem gewählten Musterteil abgeleitet.</p>':''}<p class="small muted">X ${poseValue(pose,0)} · Y ${poseValue(pose,1)} · Z ${poseValue(pose,2)} mm</p><div class="bar"><button class="primary" data-teach="${esc(key)}" ${linked?'disabled':''}>Position einlernen</button><button data-move-here="${esc(key)}" ${!taught?'disabled':''}>Zu Position bewegen</button></div><details ${this.advanced?'open':''}><summary>Koordinaten und Gelenkstellung</summary><div class="six">${pose.map((_,i)=>this.input(labels[i],`pose:${key}:${i}`,poseValue(pose,i),'number',`step="any" ${linked?'disabled':''}`)).join('')}</div><div class="bar"><button data-confirm-pose="${esc(key)}" ${linked?'disabled':''}>Eingegebene Werte geprüft</button>${key!=='feature'?`<button data-confirm-joints="${esc(key)}" ${linked?'disabled':''}>Gelenkstellung am Ziel bestätigen</button>`:''}</div>${key!=='feature'?`<p class="small muted" data-joint-hint-status>${hint?`Pose und Gelenke gemessen · ${esc(hint.robotType)} · TCP ${esc(hint.tcp?.name)}`:'Keine gemessene Gelenkstellung. MoveJ mit gemessenem Hinweis erfordert Einlernen.'}</p>`:''}</details><button class="quiet" data-next-pose>Nächster Punkt →</button></section>`;
  }
  private featureHtml(r:Recipe):string{
    const selected=this.node!.parameters.featureFrame;
    const names=[...new Set([...this.frames.filter(f=>!['tcp','flange'].includes(f.name)).map(f=>f.name),...(selected?[selected]:[])])];
    return `<div class="bar"><label class="field">Palettenbezug<select data-feature-frame><option value="" ${!selected?'selected':''}>Manuelle Ursprungspose</option>${names.map(name=>`<option value="${esc(name)}" ${selected===name?'selected':''}>PolyScope-Frame: ${esc(name)}</option>`).join('')}</select></label><button data-load-frames>PolyScope-Frames laden</button></div>${selected?`<div class="note">Verknüpft mit <strong>${esc(selected)}</strong>. Einlernen dieses Frames in der PolyScope-Anwendung verschiebt alle Palettenpositionen beim nächsten Aufruf. Der Bezug wird je Teileaufruf einmal ermittelt.</div><p class="small muted">Zuletzt geladene Ursprungspose in Basis: ${r.featurePose.map((v,i)=>`${poseValue(r.featurePose,i)} ${i<3?'mm':'rad'}`).join(' · ')}</p>`:this.poseCard('feature','Palettenursprung in Basis',r.featurePose)}`;
  }
  private motionHtml(kind:MotionKind,phase:MotionPhase):string{
    const profile=motionSettings(this.node!)[kind][phase];const factor=profile.type==='joint'?180/Math.PI:1000;
    const unit=profile.type==='joint'?'°':'mm';const key=`${kind}.${phase}`;
    const qNear=profile.type==='joint'?`<label class="field">Gelenkhinweis<select data-motion="${key}.qNearMode"><option value="taught" ${profile.qNearMode==='taught'?'selected':''}>Gemessene Gelenkstellung · PS5-Zuordnung</option><option value="current" ${profile.qNearMode==='current'?'selected':''}>Aktuelle Gelenkstellung · ausdrücklicher Fallback</option></select></label><p class="small muted">${profile.qNearMode==='current'?'MoveJ löst die Zielpose ausgehend von den Gelenken unmittelbar vor der Bewegung. Der Bewegungszweig kann sich gegenüber der eingelernten Stellung ändern.':'Bei Teile-Anfahrt bestimmt das Muster den Hinweis; Werkzeugaktion, Ausfahrt und Zwischenlagen verwenden ihren eigenen eingelernten Punkt.'}</p>`:'';
    return `${qNear}<div class="grid"><label class="field">Bewegung<select data-motion="${key}.type"><option value="linear" ${profile.type==='linear'?'selected':''}>Linear · MoveL</option><option value="joint" ${profile.type==='joint'?'selected':''}>Gelenkbewegung · MoveJ</option></select></label><label class="field">Geschwindigkeit · ${unit}/s<input data-motion="${key}.speed" type="number" min="0.001" step="any" value="${Number((profile.speed*factor).toFixed(5))}"></label><label class="field">Beschleunigung · ${unit}/s²<input data-motion="${key}.acceleration" type="number" min="0.001" step="any" value="${Number((profile.acceleration*factor).toFixed(5))}"></label><label class="field">Überschleifradius · mm<input data-motion="${key}.blend" type="number" min="0" max="100" step="any" value="${profile.blend*1000}" ${phase==='action'?'disabled':''}></label></div>${phase==='action'?'<p class="small muted">Vollständiger Halt am Werkzeug-Aktionspunkt vor Benutzeraktionen (Radius 0).</p>':''}`;
  }
  private pathsHtml(r: Recipe): string {
    const selected=this.node!.parameters.referenceSelection;const pattern=r.patterns.find(p=>p.id===selected?.patternId);
    const reference=`<section class="card"><h3>Referenzteil</h3><div class="grid"><label class="field">Referenzmuster<select data-reference-pattern><option value="" ${!selected?'selected':''}>Manuell eingelernte Referenz</option>${r.patterns.map(p=>`<option value="${esc(p.id)}" ${selected?.patternId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label>${selected?`<label class="field">Referenzteil · 1 bis ${pattern?patternItemCount(pattern):0}<input data-reference-item type="number" min="1" max="${pattern?patternItemCount(pattern):0}" step="1" value="${selected.itemIndex+1}"></label>`:''}</div><p class="small muted">Ein geändertes Referenzteil verlangt erneutes Einlernen oder Prüfen von Anfahrt, Werkzeugaktion und Ausfahrt. Alle Punkte beziehen sich auf dieselbe unterste Lage.</p></section>`;
    const names={reference:'Referenzteil',approach:'Anfahrpunkt',action:'Werkzeug-Aktionspunkt',exit:'Ausfahrpunkt'};
    const points=(kind:MotionKind,waypoints:WaypointTemplate)=>(['reference','approach','action','exit'] as const).map(phase=>`${this.poseCard(kind==='item'?phase:`separator.${phase}`,kind==='item'?names[phase]:`Zwischenlage · ${names[phase]}`,waypoints[phase])}${phase==='reference'?'':this.motionHtml(kind,phase)}`).join('');
    return `<details><summary>Einfachen Ablauf verwenden</summary><p class="small muted">Ersetzt die individuellen Teilepunkte durch Aktion am ersten Musterteil und einen gemeinsamen Abstand entlang Paletten-Z. Danach erneut prüfen.</p><button data-vertical-on>Einfachen Ablauf neu festlegen</button></details>${reference}<section class="card"><h3>Teile-Ablauf</h3>${points('item',r.waypoints)}</section><label class="field">Orientierungsverhalten<select data-field="orientationPolicy"><option value="ps5-reference-relative" ${r.orientationPolicy!=='fixed-feature'?'selected':''}>PolyScope-5-Referenzbezug</option><option value="fixed-feature" ${r.orientationPolicy==='fixed-feature'?'selected':''}>Anfahrt / Ausfahrt im Palettenframe fest</option></select></label>${r.layers.some(l=>l.separatorAfter)&&r.separator?`<section class="card"><h3>Zwischenlagen-Ablauf</h3>${points('separator',r.separator.waypoints)}</section>`:''}<section class="card"><h3>Programmzähler</h3><div class="grid"><label class="field">Teilezähler · 1-basiert<input data-counter="itemCounter" value="${esc(this.node!.parameters.itemCounter.name)}"></label><label class="field">Gesamtzahl Teile<input data-counter="totalCounter" value="${esc(this.node!.parameters.totalCounter.name)}"></label></div></section><div class="note">Vorbereitungen vor Anfahrt; Werkzeugaktionen am Aktionspunkt; Rückfahrt / Ablage in den getrennten Nachbereitungszweigen nach Ausfahrt. „Zu Position bewegen“ öffnet den PolyScope-Bewegungsdialog ohne die gespeicherte Position zu ändern.</div>`;
  }
  private render() {
    if (!this.isConnected) return;
    if (!this.node) { this.shadow.innerHTML = `<style>${CSS}</style><p>Palettierassistent wird geladen …</p>`; return; }
    try {
      const r=this.node.parameters.recipe;
      this.patternIndex=Math.max(0,Math.min(this.patternIndex,r.patterns.length-1));
      const restore=this.renderedStep===this.step&&this.renderedAdvanced===this.advanced;
      const openDetails=restore?Array.from(this.shadow.querySelectorAll<HTMLDetailsElement>('details[open]')).map(el=>`${el.closest('[data-pose-key]')?.getAttribute('data-pose-key')??''}:${el.querySelector('summary')?.textContent}`):[];
      const scroll=restore?this.shadow.querySelector('.editor-scroll')?.scrollTop??0:0;
      const keys=this.visiblePoseKeys();
      if(!keys.includes(this.activePose))this.activePose=keys.find(k=>this.node!.parameters.taught[k]!==true)??keys[0]??'';
      const c:ViewContext={node:this.node,patternIndex:this.patternIndex,advanced:this.advanced,frames:this.frames,pose:(key,title,pose)=>this.poseCard(key,title,pose),input:(...args)=>this.input(...args),feature:()=>this.featureHtml(r)};
      const simple=simpleMotionView(c);
      const content=this.step<0?homeView(c):[()=>recipeView(c),()=>patternView(c),()=>layersView(c),()=>simple?`${simple}${this.separatorPaths(r)}${this.advanced?this.counterHtml():''}`:this.pathsHtml(r),()=>reviewView(c,this.resetRequested)][this.step]();
      const errors=nodeErrors(this.node);
      this.shadow.innerHTML=`<style>${CSS}${OVERVIEW_CSS}</style><div class="shell"><header class="shell-header"><div class="shell-title"><h2>Palettierassistent</h2><span class="small muted" data-recipe-label>${esc(r.name)} · ${r.mode==='palletize'?'Palettieren':'Depalettieren'}</span></div><div class="bar"><span data-approval-status class="status ${errors.length?'':'ok'}">${errors.length?'In Einrichtung':'Freigegeben'}</span><button class="mode-toggle" data-toggle-advanced aria-pressed="${this.advanced}">${this.advanced?'Normalansicht':'Expertenansicht'}</button></div></header><div class="shell-content"><aside class="visual-side" aria-label="Palettenübersicht">${renderOverview(r,{layerIndex:this.viewLayer,eventIndex:this.viewEvent})}</aside><section class="editor-side" aria-label="Einrichtung">${this.step<0?'':`<div class="editor-top"><button class="quiet" data-home>← Übersicht</button><span class="small muted">${viewTitles[this.step]}</span></div>`}<div class="editor-scroll">${content}</div></section></div>${this.notice?`<div class="notice" role="status">${esc(this.notice)}</div>`:''}<footer class="shell-footer"><button data-cancel-dialog>Abbrechen</button><div class="bar">${this.step!==4?'<button data-step="4">Prüfen</button>':''}<button class="primary" data-confirm-dialog>${errors.length?'Entwurf speichern':'Übernehmen'}</button></div></footer></div>`;
      if(restore){this.shadow.querySelectorAll<HTMLDetailsElement>('details').forEach(el=>{const key=`${el.closest('[data-pose-key]')?.getAttribute('data-pose-key')??''}:${el.querySelector('summary')?.textContent}`;if(openDetails.includes(key))el.open=true;});const pane=this.shadow.querySelector('.editor-scroll');if(pane)pane.scrollTop=scroll;}
      this.renderedStep=this.step;this.renderedAdvanced=this.advanced;this.bind();
    } catch(error) { this.shadow.innerHTML=`<style>${CSS}</style><div class="note warning">Rezept kann nicht gelesen werden: ${esc(error)}. Knoten neu anlegen oder gültiges Rezept importieren.</div>`; }
  }
  private visiblePoseKeys():string[]{
    if(!this.node)return[];const r=this.node.parameters.recipe,p=r.patterns[Math.min(this.patternIndex,r.patterns.length-1)];
    if(this.step===0)return this.node.parameters.featureFrame?[]:['feature'];
    if(this.step===1){if(p.kind==='line')return[`${p.id}.start`,`${p.id}.end`];if(p.kind==='grid')return(this.node.parameters.setup?.rectangles[p.id]?[0,2]:[0,1,2,3]).map(i=>`${p.id}.corner${i}`);return p.poses.map((_,i)=>`${p.id}.point${i}`);}
    if(this.step===2)return r.layers.some(l=>l.separatorAfter)?['separator.pose']:[];
    if(this.step===3)return[...(this.node.parameters.setup?.vertical?[]:['reference','approach','action','exit']),...(r.layers.some(l=>l.separatorAfter)?['separator.reference','separator.approach','separator.action','separator.exit']:[])];
    return[];
  }
  private separatorPaths(r:Recipe):string{
    if(!r.layers.some(l=>l.separatorAfter)||!r.separator)return'';
    const names={reference:'Referenzpunkt',approach:'Anfahrt',action:'Werkzeugaktion',exit:'Ausfahrt'};
    return `<details open><summary>Zwischenlagenbewegung</summary>${(['reference','approach','action','exit'] as const).map(phase=>`${this.poseCard(`separator.${phase}`,names[phase],r.separator!.waypoints[phase])}${phase==='reference'?'':`<details ${this.advanced?'open':''}><summary>${names[phase]} · Bewegungseinstellungen</summary>${this.motionHtml('separator',phase)}</details>`}`).join('')}</details>`;
  }
  private counterHtml():string{return `<details><summary>Programmzähler</summary><div class="grid">${(['itemCounter','totalCounter'] as const).map((key,i)=>`<label class="field">${i?'Gesamtzahl Teile':'Teilezähler · 1-basiert'}<input data-counter="${key}" value="${esc(this.node!.parameters[key].name)}"></label>`).join('')}</div></details>`;}
  private bind() {
    const on=(selector:string, handler:(e:Event, el:HTMLElement)=>void)=>this.shadow.querySelectorAll<HTMLElement>(selector).forEach(el=>el.addEventListener('click', e=>handler(e,el)));
    on('[data-cancel-dialog]',()=>this.dispatchEvent(new CustomEvent('closeDialog',{detail:{reason:'CANCELLED'}})));
    on('[data-confirm-dialog]',()=>{if(!this.busy)this.dispatchEvent(new CustomEvent('closeDialog',{detail:{reason:'CONFIRMED',returnData:clone(this.inputData)}}));});
    on('[data-step]',(_,el)=>{this.step=Number(el.dataset.step);this.notice='';this.render();});
    on('[data-home]',()=>{this.step=-1;this.render();});
    on('[data-toggle-advanced]',()=>{this.advanced=!this.advanced;this.render();});
    on('[data-focus-pose]',(_,el)=>{this.activePose=el.dataset.focusPose!;this.render();});
    on('[data-next-pose]',()=>{const keys=this.visiblePoseKeys(),index=keys.indexOf(this.activePose);this.activePose=keys[(index+1)%keys.length]??'';this.render();});
    on('[data-view-layer]',(_,el)=>{this.viewLayer=Number(el.dataset.viewLayer);this.viewEvent=undefined;this.render();});
    const selectItem=(el:HTMLElement)=>{this.viewEvent=Number(el.dataset.viewItem);this.render();};
    on('[data-view-item]',(_,el)=>selectItem(el));
    this.shadow.querySelectorAll<HTMLElement>('g[data-view-item]').forEach(el=>el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectItem(el);}}));
    on('[data-review-rectangle]',(_,el)=>void this.updateSetup(n=>reviewRectangleSetup(n,el.dataset.reviewRectangle!),false));
    on('[data-review-vertical]',()=>void this.updateSetup(n=>reviewVerticalSetup(n),false));
    on('[data-rectangle-off]',()=>void this.updateSetup(n=>setRectangleSetup(n,n.parameters.recipe.patterns[this.patternIndex].id,false)));
    on('[data-rectangle-on]',()=>void this.updateSetup(n=>setRectangleSetup(n,n.parameters.recipe.patterns[this.patternIndex].id,true)));
    on('[data-vertical-off]',()=>void this.updateSetup(n=>clearVerticalSetup(n)));
    on('[data-vertical-on]',()=>void this.updateSetup(n=>setVerticalSetup(n,n.parameters.recipe.patterns[this.patternIndex].id,.1)));
    this.shadow.querySelector<HTMLInputElement>('[data-clearance]')?.addEventListener('change',e=>void this.updateSetup(n=>setVerticalSetup(n,n.parameters.setup!.vertical!.patternId,Number((e.target as HTMLInputElement).value)/1000)));
    this.shadow.querySelector<HTMLInputElement>('[data-layer-count]')?.addEventListener('change',e=>{const count=Number((e.target as HTMLInputElement).value);if(!Number.isSafeInteger(count)||count<1||count>10000){this.notice='Lagenanzahl muss eine ganze Zahl zwischen 1 und 10000 sein.';this.render();return;}void this.save(n=>{const r=n.parameters.recipe,existing=[...r.layers];r.layers=Array.from({length:count},(_,i)=>existing[i]??{id:id(),patternId:existing.at(-1)!.patternId,separatorAfter:false});});});
    on('[data-open-missing]',()=>{const p=this.node!.parameters,missing=requiredTeachKeys(p.recipe).filter(k=>p.taught[k]!==true);if(missing.includes('feature'))this.step=0;else{const index=p.recipe.patterns.findIndex(pattern=>missing.some(k=>k.startsWith(pattern.id+'.')));if(index>=0){this.patternIndex=index;this.step=1;}else this.step=missing.includes('separator.pose')?2:3;}this.activePose='';this.render();});
    on('[data-prev]',()=>{this.step--;this.render();}); on('[data-next]',()=>{this.step++;this.render();});
    this.shadow.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach(el=>el.addEventListener('change',()=>void this.changeField(el)));
    this.shadow.querySelector<HTMLSelectElement>('[data-pattern]')?.addEventListener('change',e=>{this.patternIndex=Number((e.target as HTMLSelectElement).value);this.render();});
    on('[data-teach]',(_,el)=>void this.teach(el.dataset.teach!));
    on('[data-move-here]',(_,el)=>void this.moveHere(el.dataset.moveHere!));
    on('[data-confirm-joints]',(_,el)=>void this.confirmJoints(el.dataset.confirmJoints!));
    this.shadow.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[data-motion]').forEach(el=>el.addEventListener('change',()=>void this.changeMotion(el)));
    this.shadow.querySelector<HTMLSelectElement>('[data-reference-pattern]')?.addEventListener('change',e=>void this.save(n=>{const patternId=(e.target as HTMLSelectElement).value;n.parameters.referenceSelection=patternId?{patternId,itemIndex:0}:undefined;if(!patternId)n.parameters.taught.reference=false;}));
    this.shadow.querySelector<HTMLInputElement>('[data-reference-item]')?.addEventListener('change',e=>void this.save(n=>{if(n.parameters.referenceSelection)n.parameters.referenceSelection.itemIndex=Number((e.target as HTMLInputElement).value)-1;},true,false));
    on('[data-load-frames]',()=>void this.loadFrames());
    this.shadow.querySelector<HTMLSelectElement>('[data-feature-frame]')?.addEventListener('change',e=>void this.selectFrame((e.target as HTMLSelectElement).value));
    on('[data-confirm-pose]',(_,el)=>void this.save(n=>{n.parameters.taught[el.dataset.confirmPose!]=true;}));
    on('[data-add-pattern]',()=>void this.save(n=>{const patterns=[...n.parameters.recipe.patterns]; const p=clone(createDefaultRecipe().patterns[0]);p.id=id();p.name=`Muster ${patterns.length+1}`;patterns.push(p);n.parameters.recipe.patterns=patterns;if(n.parameters.setup)n.parameters.setup.rectangles[p.id]={kind:'axis-aligned'};this.patternIndex=patterns.length-1;}));
    on('[data-duplicate-pattern]',()=>void this.save(n=>{const source=n.parameters.recipe.patterns[this.patternIndex];const copy=clone(source);copy.id=id();copy.name=`${source.name} Kopie`;n.parameters.recipe.patterns=[...n.parameters.recipe.patterns,copy];if(n.parameters.setup?.rectangles[source.id])n.parameters.setup.rectangles[copy.id]={kind:'axis-aligned'};n.parameters.recipe=duplicatePatternHints(n.parameters.recipe,source.id,copy.id,id);for(const [key,value] of Object.entries(n.parameters.taught))if(key.startsWith(`${source.id}.`))n.parameters.taught[`${copy.id}${key.slice(source.id.length)}`]=value;this.patternIndex=n.parameters.recipe.patterns.length-1;}));
    this.shadow.querySelectorAll<HTMLInputElement>('[data-counter]').forEach(el=>el.addEventListener('change',()=>void this.renameCounter(el.dataset.counter as 'itemCounter'|'totalCounter',el.value)));
    on('[data-remove-pattern]',()=>void this.save(n=>{const r=n.parameters.recipe;const removed=r.patterns[this.patternIndex];n.parameters.recipe=removePatternHints(r,removed.id);n.parameters.recipe.patterns=r.patterns.filter(p=>p.id!==removed.id);n.parameters.recipe.layers=r.layers.map(l=>l.patternId===removed.id?{...l,patternId:n.parameters.recipe.patterns[0].id}:l);if(n.parameters.setup){delete n.parameters.setup.rectangles[removed.id];if(n.parameters.setup.vertical?.patternId===removed.id)n.parameters.setup.vertical.patternId=n.parameters.recipe.patterns[0].id;}this.patternIndex=0;}));
    on('[data-add-point]',()=>void this.save(n=>{const p=n.parameters.recipe.patterns[this.patternIndex];if(p.kind==='irregular')n.parameters.recipe=addIrregularPoint(n.parameters.recipe,p.id,ZERO,id);}));
    on('[data-remove-point]',(_,el)=>void this.save(n=>{const p=n.parameters.recipe.patterns[this.patternIndex];if(p.kind==='irregular')n.parameters.recipe=removeIrregularPoint(n.parameters.recipe,p.id,Number(el.dataset.removePoint));for(const key of Object.keys(n.parameters.taught))if(key.startsWith(`${p.id}.point`))delete n.parameters.taught[key];}));
    const addLayer=(duplicate:boolean)=>void this.save(n=>{const r=n.parameters.recipe;r.layers=[...r.layers,{id:id(),patternId:duplicate?r.layers.at(-1)!.patternId:r.patterns[0].id,separatorAfter:duplicate?r.layers.at(-1)!.separatorAfter:false}];});
    on('[data-add-layer]',()=>addLayer(false));on('[data-duplicate-layer]',()=>addLayer(true));
    on('[data-remove-layer]',(_,el)=>void this.save(n=>{n.parameters.recipe.layers=n.parameters.recipe.layers.filter((_,i)=>i!==Number(el.dataset.removeLayer));}));
    this.shadow.querySelectorAll<HTMLSelectElement>('[data-layer]').forEach(el=>el.addEventListener('change',()=>void this.save(n=>{n.parameters.recipe.layers[Number(el.dataset.layer)].patternId=el.value;})));
    this.shadow.querySelectorAll<HTMLInputElement>('[data-separator-layer]').forEach(el=>el.addEventListener('change',()=>void this.save(n=>{const r=n.parameters.recipe;r.layers[Number(el.dataset.separatorLayer)].separatorAfter=el.checked;if(el.checked&&!r.separator)r.separator={height:.002,pose:ZERO,waypoints:clone(r.waypoints)};})));
    on('[data-approve]',()=>void this.save(n=>{n.parameters.approvedRevision=n.parameters.recipe.revision;n.parameters.approvedPlannerVersion=CURRENT_PLANNER_VERSION;},false));
    on('[data-reset]',()=>void this.resetProgress());
    on('[data-start]',()=>void this.resetProgress(this.node!.parameters.startItem??1));
    this.shadow.querySelector<HTMLInputElement>('[data-start-item]')?.addEventListener('change',e=>void this.save(n=>{n.parameters.startItem=Number((e.target as HTMLInputElement).value);},false,false));
    on('[data-export]',()=>{const blob=new Blob([JSON.stringify(this.node!.parameters.recipe,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='palletizing-recipe.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),500);});
    on('[data-import]',()=>this.shadow.querySelector<HTMLInputElement>('[data-file]')?.click());
    this.shadow.querySelector<HTMLInputElement>('[data-file]')?.addEventListener('change',e=>void this.importRecipe((e.target as HTMLInputElement).files?.[0]));
    if(this.api)this.shadow.querySelectorAll<HTMLInputElement>('input:not([type=checkbox]):not([type=file])').forEach(el=>{if(el.disabled)return;el.readOnly=true;el.addEventListener('click',()=>void this.editValue(el));});
  }
  private async updateSetup(change:(node:PalletNode)=>PalletNode,geometry=true){try{await this.save(n=>Object.assign(n,change(n)),geometry);}catch(error){this.notice=error instanceof Error?error.message:String(error);this.render();}}
  private async editValue(el:HTMLInputElement){
    if(!this.api||this.busy)return;
    try{
      const numeric=el.type==='number',integer=numeric&&el.step==='1';
      const label=el.closest('label')?.childNodes[0]?.textContent?.trim()||'Wert';
      const min=el.min!==''?Number(el.min):undefined,max=el.max!==''?Number(el.max):undefined;
      const value=await this.api.expressionEditorService.openExpressionEditor({label,inputLabel:label,expressionEditorValue:numeric?Number(el.value):el.value,valueType:numeric?(integer?'integer':'float'):'string',tabs:['VALUE'],keyboardLayout:numeric?(integer?(min!==undefined&&min>=0?'numeric-fixed-positive':'numeric-fixed'):(min!==undefined&&min>=0?'numeric-free-positive':'numeric-free')):'alpha-numeric',...(min===undefined?{}:{min}),...(max===undefined?{}:{max}),...(integer?{step:1}:{})});
      if(value===undefined)return;
      if(numeric?(typeof value!=='number'||!Number.isFinite(value)):typeof value!=='string')throw new Error('Bitte einen direkten gültigen Wert eingeben.');
      el.value=String(value);el.dispatchEvent(new Event('change',{bubbles:true}));
    }catch(error){this.notice=`Eingabe fehlgeschlagen: ${String(error)}`;this.render();}
  }
  private async changeField(el: HTMLInputElement | HTMLSelectElement) {
    const field=el.dataset.field!;const value=el.type==='checkbox'?(el as HTMLInputElement).checked:el.value;
    await this.save(n=>{
      const r=n.parameters.recipe; const p=r.patterns[this.patternIndex];
      if(field.startsWith('pose:')){const [,key,index]=field.split(':');if(n.parameters.setup){if(['reference','approach','action','exit'].includes(key))delete n.parameters.setup.vertical;if(/\.corner[13]$/.test(key))delete n.parameters.setup.rectangles[key.split('.')[0]];}const pose=[...this.getPose(r,key)] as unknown as number[];pose[Number(index)]=Number(value)/(Number(index)<3?1000:1);this.setPose(r,key,pose as unknown as Pose);n.parameters.taught[key]=false;return;}
      switch(field){
        case'name':r.name=String(value);break;case'mode':r.mode=value as Recipe['mode'];break;case'objectHeight':r.objectHeight=Number(value)/1000;break;
        case'rememberProgress':r.rememberProgress=Boolean(value);break;case'autoRepeat':n.parameters.autoRepeat=Boolean(value);break;
        case'blend':n.parameters.blend=Number(value)/1000;break;case'speed':n.parameters.speed=Number(value)/1000;break;case'acceleration':n.parameters.acceleration=Number(value)/1000;break;
        case'orientationPolicy':if(n.parameters.setup)delete n.parameters.setup.vertical;r.orientationPolicy=value as Recipe['orientationPolicy'];break;
        case'pattern.name':p.name=String(value);break;
        case'pattern.kind':{const kind=value as Pattern['kind'];let replacement:Pattern;if(kind==='line')replacement={id:p.id,name:p.name,kind,start:ZERO,end:[.1,0,0,0,0,0],count:2};else if(kind==='grid')replacement={...clone(createDefaultRecipe().patterns[0]),id:p.id,name:p.name};else replacement={id:p.id,name:p.name,kind:'irregular',poses:[ZERO]};r.patterns=r.patterns.map((item,i)=>i===this.patternIndex?replacement:item);if(n.parameters.setup){delete n.parameters.setup.rectangles[p.id];if(kind==='grid')n.parameters.setup.rectangles[p.id]={kind:'axis-aligned'};}for(const key of Object.keys(n.parameters.taught))if(key.startsWith(`${p.id}.`))delete n.parameters.taught[key];break;}
        case'pattern.count':if(p.kind==='line')p.count=Number(value);break;case'pattern.rows':if(p.kind==='grid')p.rows=Number(value);break;case'pattern.columns':if(p.kind==='grid')p.columns=Number(value);break;
        case'separator.height':if(r.separator)r.separator.height=Number(value)/1000;break;
      }
    },true,field==='pattern.kind');
  }
  private getPose(r: Recipe, key: string): Pose {
    if(key==='feature')return r.featurePose;
    if(['reference','approach','action','exit'].includes(key))return r.waypoints[key as keyof WaypointTemplate];
    if(key.startsWith('separator.'))return key==='separator.pose'?r.separator!.pose:r.separator!.waypoints[key.slice(10) as keyof WaypointTemplate];
    const [pid,part]=key.split('.');const p=r.patterns.find(x=>x.id===pid)!;
    if(p.kind==='line')return p[part as 'start'|'end'];if(p.kind==='grid')return p.corners[Number(part.slice(6))];return p.poses[Number(part.slice(5))];
  }
  private setPose(r: Recipe, key: string, pose: Pose) {
    if(key==='feature'){r.featurePose=pose;return;}
    if(['reference','approach','action','exit'].includes(key)){r.waypoints[key as keyof WaypointTemplate]=pose;return;}
    if(key.startsWith('separator.')){if(key==='separator.pose')r.separator!.pose=pose;else r.separator!.waypoints[key.slice(10) as keyof WaypointTemplate]=pose;return;}
    const [pid,part]=key.split('.');const p=r.patterns.find(x=>x.id===pid)!;
    if(p.kind==='line')p[part as 'start'|'end']=pose;
    if(p.kind==='grid')p.corners=p.corners.map((v,i)=>i===Number(part.slice(6))?pose:v) as unknown as typeof p.corners;
    if(p.kind==='irregular')p.poses=p.poses.map((v,i)=>i===Number(part.slice(5))?pose:v);
  }
  private async teach(key:string) {
    if(!this.api){this.notice='Einlernen ist nur innerhalb von PolyScope X möglich.';this.render();return;}
    try{
      const current=await this.api.robotPositionService.getCurrentPosition();if(!current)throw new Error('Aktuelle Roboterstellung ist nicht verfügbar.');
      const options=lockedTeachOptions(current,key==='feature'?'Palettenursprung':key);
      const position:Waypoint|undefined=await this.api.robotMoveService.openMoveScreen(options);
      if(!position)return;
      assertTeachTcp(position,options.tcp);
      if(position.frame!=='base')throw new Error('Die eingelesene Position muss im Basisframe liegen.');
      const pose=[...position.pose.position,...position.pose.orientation] as Pose;
      const feature=this.node!.parameters.featureFrame?featurePoseFromFrames(await this.readFrames(),this.node!.parameters.featureFrame):this.node!.parameters.recipe.featurePose;
      const robotType=await this.api.robotInfoService.getRobotType();
      await this.save(n=>{if(n.parameters.setup&&['reference','approach','action','exit'].includes(key))delete n.parameters.setup.vertical;n.parameters.recipe.featurePose=feature;const local=key==='feature'?pose:toFeaturePose(feature,pose);this.setPose(n.parameters.recipe,key,local);if(key!=='feature')n.parameters.recipe=setJointHint(n.parameters.recipe,key,measuredHint(position,local,feature,robotType),id);n.parameters.taught[key]=true;});
    }catch(error){this.notice=`Einlernen fehlgeschlagen: ${String(error)}`;this.render();}
  }
  private async moveHere(key:string){
    if(!this.api||!this.node){this.notice='Bewegungsdialog ist nur in PolyScope X verfügbar.';this.render();return;}
    try{
      if(this.node.parameters.taught[key]!==true)throw new Error('Position zuerst einlernen oder prüfen.');
      if(validateRecipe(this.node.parameters.recipe).length)throw new Error('Rezept enthält ungültige Geometrie.');
      const current=await this.api.robotPositionService.getCurrentPosition();if(!current)throw new Error('Aktuelle Roboterstellung ist nicht verfügbar.');
      const frame=this.node.parameters.featureFrame?featurePoseFromFrames(await this.readFrames(),this.node.parameters.featureFrame):this.node.parameters.recipe.featurePose;
      const target=key==='feature'?this.getPose(this.node.parameters.recipe,key):composePoses(frame,this.getPose(this.node.parameters.recipe,key));
      const hint=getJointHint(this.node.parameters.recipe,key);if(hint){const error=hintCompatibility(hint,await this.api.robotInfoService.getRobotType(),current.tcp);if(error)throw new Error(error);}
      await this.api.robotMoveService.autoMove({frame:'base',pose:{position:[target[0],target[1],target[2]],orientation:[target[3],target[4],target[5]]},qNear:hint?jointObject(hint.q):current.qNear,tcp:current.tcp});
      this.notice='Bewegungsdialog geschlossen. Gespeicherte Position bleibt erhalten.';this.render();
    }catch(error){this.notice=`Bewegungsdialog konnte nicht geöffnet werden: ${String(error)}`;this.render();}
  }
  private async confirmJoints(key:string){
    if(!this.api||!this.node)return;
    try{
      if(validateRecipe(this.node.parameters.recipe).length)throw new Error('Rezept enthält ungültige Geometrie.');
      const current=await this.api.robotPositionService.getCurrentPosition();if(!current)throw new Error('Aktuelle Roboterstellung ist nicht verfügbar.');
      const feature=this.node.parameters.featureFrame?featurePoseFromFrames(await this.readFrames(),this.node.parameters.featureFrame):this.node.parameters.recipe.featurePose;
      const local=this.getPose(this.node.parameters.recipe,key),target=composePoses(feature,local),hint=getJointHint(this.node.parameters.recipe,key);
      const robotType=await this.api.robotInfoService.getRobotType();if(hint){const error=hintCompatibility(hint,robotType,current.tcp);if(error)throw new Error(error);}
      const options=lockedTeachOptions(current,`Gelenkstellung am Ziel: ${key}`);
      const position=await this.api.robotMoveService.openMoveScreen({...options,position:{frame:'base',pose:{position:[target[0],target[1],target[2]],orientation:[target[3],target[4],target[5]]},qNear:hint?jointObject(hint.q):current.qNear,tcp:current.tcp}});
      if(!position)return;
      assertTeachTcp(position,options.tcp);
      const actual=[...position.pose.position,...position.pose.orientation] as Pose;
      if(position.frame!=='base'||!atTarget(actual,target))throw new Error('Ziel noch nicht erreicht (Toleranz 0,1 mm / 0,001 rad). Gelenkhinweis wurde nicht gespeichert.');
      await this.save(n=>{n.parameters.recipe.featurePose=feature;n.parameters.recipe=setJointHint(n.parameters.recipe,key,measuredHint(position,local,feature,robotType),id);n.parameters.taught[key]=true;});
      this.notice='Gemessene Gelenkstellung gespeichert; die eingegebene Zielpose bleibt unverändert.';this.render();
    }catch(error){this.notice=`Gelenkstellung konnte nicht bestätigt werden: ${String(error)}`;this.render();}
  }
  private async changeMotion(el:HTMLInputElement|HTMLSelectElement){
    const [kind,phase,field]=el.dataset.motion!.split('.') as [MotionKind,MotionPhase,'type'|'speed'|'acceleration'|'blend'|'qNearMode'];
    await this.save(n=>{n.parameters.motion=clone(motionSettings(n));const profile=n.parameters.motion[kind][phase];if(field==='type'){profile.type=el.value as 'linear'|'joint';profile.speed=profile.type==='joint'?.5:.1;profile.acceleration=profile.type==='joint'?1:.25;profile.qNearMode??='taught';}else if(field==='qNearMode')profile.qNearMode=el.value as 'taught'|'current';else profile[field]=Number(el.value)/(field==='blend'?1000:profile.type==='joint'?180/Math.PI:1000);if(phase==='action')profile.blend=0;},true,field==='type'||field==='qNearMode');
  }
  private async readFrames():Promise<Frame[]>{
    if(!this.api)throw new Error('PolyScope-Frames sind nur im Simulator oder am Roboter verfügbar.');
    return await readFrameSnapshot(this.frameService!);
  }
  private async loadFrames(){
    try{this.frames=await this.readFrames();const selected=this.node?.parameters.featureFrame;if(selected){const pose=featurePoseFromFrames(this.frames,selected);await this.save(n=>{n.parameters.recipe.featurePose=pose;},false);}this.notice='PolyScope-Frames geladen. Gewünschten Palettenframe auswählen.';this.render();}
    catch(error){this.notice=String(error);this.render();}
  }
  private async selectFrame(name:string){
    try{if(!name){await this.save(n=>{n.parameters.featureFrame=undefined;n.parameters.taught.feature=false;});return;}this.frames=await this.readFrames();const pose=featurePoseFromFrames(this.frames,name);await this.save(n=>{n.parameters.featureFrame=name;n.parameters.recipe.featurePose=pose;n.parameters.taught.feature=true;});}
    catch(error){this.notice=`Frame konnte nicht gewählt werden: ${String(error)}`;this.render();}
  }
  private async resetProgress(startItem=1){
    if(!this.node)return;
    try{cursorForStartItem(this.node.parameters.recipe,startItem);}catch(error){this.notice=String(error);this.render();return;}
    this.resetRequested=true;
    await this.save(n=>{n.parameters.startItem=startItem;if(n.parameters.recipe.rememberProgress){n.parameters.resumeVariable=`${prefix(n)}_resume`;n.parameters.resumeRevision=n.parameters.recipe.revision;n.parameters.resumePlannerVersion=CURRENT_PLANNER_VERSION;}},false);
    this.notice=`Start bei Teil ${startItem} vorgemerkt. Erst „Übernehmen“ speichert die Auswahl; anschließend Programm neu starten.`;this.render();
  }
  private async importRecipe(file?:File){
    if(!file)return;
    try{if(file.size>2_000_000)throw new Error('Rezeptdatei ist zu groß.');const recipe=JSON.parse(await file.text());const issues=validateRecipe(recipe);if(issues.length)throw new Error(issues.map(x=>`${x.path}: ${x.message}`).slice(0,4).join('; '));
      const typed=migrateRecipe(recipe as Recipe);const patternIds=new Map(typed.patterns.map(p=>[p.id,id()]));typed.patterns=typed.patterns.map(p=>({...p,id:patternIds.get(p.id)!}));typed.layers=typed.layers.map(l=>({...l,id:id(),patternId:patternIds.get(l.patternId)!}));
      this.resetRequested=false;
      await this.save(n=>{delete n.parameters.setup;n.parameters.recipe={...remapTeachingForImport(typed,Object.fromEntries(patternIds),id),id:id(),revision:1};n.parameters.startItem=1;n.parameters.referenceSelection=undefined;n.parameters.featureFrame=undefined;n.parameters.taught={};n.parameters.approvedRevision=undefined;n.parameters.approvedPlannerVersion=undefined;n.parameters.resumeVariable=undefined;n.parameters.resumeStateVariable=undefined;n.parameters.resumeRevision=undefined;n.parameters.resumePlannerVersion=undefined;});
    }catch(error){this.notice=`Import fehlgeschlagen: ${String(error)}`;this.render();}
  }
  private async renameCounter(field:'itemCounter'|'totalCounter',name:string){
    if(!this.node)return;
    try{if(!validIdentifier(name))throw new Error('Nur Buchstaben, Ziffern und Unterstriche; keine reservierten Namen.');await this.save(n=>{n.parameters[field]={...n.parameters[field],name};},true,false);}
    catch(error){this.notice=`Zählername konnte nicht geändert werden: ${String(error)}`;this.render();}
  }
}

class PalletPresenter extends HTMLElement implements ProgramPresenter {
  private node?:PalletNode; private api?:ProgramPresenterAPI; private busy=false; private notice='';
  private shadow=this.attachShadow({mode:'open'});
  get contributedNode(){return this.node;} set contributedNode(value:PalletNode|undefined){this.node=value?clone(value):undefined;this.render();}
  get presenterAPI(){return this.api;} set presenterAPI(value:ProgramPresenterAPI|undefined){this.api=value;this.render();}
  connectedCallback(){this.render();}
  private render(){
    if(!this.isConnected)return;
    const p=this.node?.parameters;const ready=!!this.node&&nodeErrors(this.node).length===0;
    this.shadow.innerHTML=`<style>${CSS}:host{height:40px;display:flex;align-items:center;overflow:hidden}.inline{display:flex;align-items:center;gap:12px;width:100%;white-space:nowrap}.inline strong{overflow:hidden;text-overflow:ellipsis}.inline button{min-height:36px;flex-shrink:0}.inline .status{flex-shrink:0}</style><div class="inline"><strong>${esc(p?.recipe?.name??'Palettierassistent')}</strong><span class="status ${ready?'ok':''}">${ready?'Freigegeben':'In Einrichtung'}</span><button class="primary" data-open ${!this.node||this.busy?'disabled':''}>Assistent öffnen</button>${this.notice?`<span role="status">${esc(this.notice)}</span>`:''}</div>`;
    this.shadow.querySelector('[data-open]')?.addEventListener('click',()=>void this.openWizard());
  }
  private async openWizard(){
    if(!this.api||!this.node||this.busy)return;this.busy=true;this.render();
    try{
      if(this.node.parameters.pendingRemap)this.node=await remapPastedSubtree(this.api.programTreeService,this.api.selectedNodeId);
      const result=await this.api.dialogService.openCustomDialog<WizardData>(WIZARD_TAG,{node:clone(this.node)},{dialogSize:'XXL',title:'Palettierassistent',showHeader:false,showFooter:false,raiseForKeyboard:false});
      if(result.reason!=='CONFIRMED'||!result.returnData)return;
      const next=clone(result.returnData.node);
      if(!validIdentifier(next.parameters.itemCounter.name)||!validIdentifier(next.parameters.totalCounter.name)||next.parameters.itemCounter.name===next.parameters.totalCounter.name)throw new Error('Teile- und Gesamtzähler brauchen verschiedene gültige Namen.');
      const previousCounters={oldItemId:this.node.parameters.itemCounter.id,oldTotalId:this.node.parameters.totalCounter.id};
      for(const field of ['itemCounter','totalCounter'] as const)if(next.parameters[field].name!==this.node.parameters[field].name)next.parameters[field]=await this.api.variableService.renameVariable(this.node.parameters[field],next.parameters[field].name);
      if(next.parameters.itemCounter.id!==previousCounters.oldItemId||next.parameters.totalCounter.id!==previousCounters.oldTotalId)next.parameters.pendingRemap=previousCounters;
      await configureProgress(new ApplicationVariablesService(this.api.programNodeService.communicationChannel),next,result.returnData.resetProgress===true);
      if(result.returnData.resetProgress&&next.parameters.recipe.rememberProgress)next.parameters.resumePlannerVersion=CURRENT_PLANNER_VERSION;
      await this.api.programNodeService.updateNode(next);this.node=next;
      if(next.parameters.pendingRemap)this.node=await remapPastedSubtree(this.api.programTreeService,this.api.selectedNodeId);
      this.notice='Gespeichert.';
    }catch(error){this.notice=`Speichern fehlgeschlagen: ${String(error)}`;}finally{this.busy=false;this.render();}
  }
}

class PhasePresenter extends HTMLElement implements ProgramPresenter {
  private node?:PhaseNode;private shadow=this.attachShadow({mode:'open'});
  get contributedNode(){return this.node;}set contributedNode(n:PhaseNode|undefined){this.node=n;this.render();}
  connectedCallback(){this.render();}
  private render(){
    if(!this.isConnected||!this.node)return;
    const phase=this.node.parameters?.phase;
    const text=['approach','action','exit'].includes(phase)?'Zielposition wird aus dem Palettenrezept berechnet.':phase==='cycle'?'Ein Teil und angrenzende Zwischenlagen pro Aufruf.':'Hier Benutzeraktionen im Programmbaum einfügen.';
    this.shadow.innerHTML=`<style>${CSS}:host{height:40px;display:flex;align-items:center;overflow:hidden}.inline{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style><span class="inline" title="${esc(text)}">${esc(text)}</span>`;
  }
}customElements.define(PALLET_TYPE,PalletPresenter);customElements.define(PHASE_TYPE,PhasePresenter);customElements.define(WIZARD_TAG,PalletWizard);

// A local preview can instantiate the same presenter with a deliberately unapproved demo recipe.
if(location.search.includes('preview')){const element=document.createElement(WIZARD_TAG) as PalletWizard;document.body.append(element);element.inputData={node:createSimplePallet()};}
