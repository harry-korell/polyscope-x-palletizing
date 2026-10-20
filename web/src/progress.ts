import { URVariable, VariableValueType } from '@universal-robots/contribution-api';
import type { ApplicationVariable, ApplicationVariablesService } from '@universal-robots/contribution-api';
import type { PalletNode } from './model.ts';
import { prefix } from './model.ts';
import { cursorForStartItem } from './counters.ts';

type Service=Pick<ApplicationVariablesService,'applicationVariables'|'createVariable'|'setVariable'>;
async function snapshot(service:Service):Promise<Record<string,ApplicationVariable>>{
  return await new Promise((resolve,reject)=>{
    let subscription:{unsubscribe():void}|undefined;let settled=false;
    const finish=(error:unknown,values?:Record<string,ApplicationVariable>)=>{if(settled)return;settled=true;clearTimeout(timeout);queueMicrotask(()=>subscription?.unsubscribe());error?reject(error):resolve(values!);};
    const timeout=setTimeout(()=>finish(new Error('Fortschrittsspeicher konnte nicht gelesen werden.')),5000);
    try{subscription=service.applicationVariables().subscribe({next:values=>finish(undefined,values),error:err=>finish(err)});}catch(error){finish(error);}
  });
}
/** Called only after an explicit dialog confirmation, never while editing/cancelling. */
export async function configureProgress(service:Service,node:PalletNode,reset:boolean):Promise<void>{
  if(!node.parameters.recipe.rememberProgress)return;
  const p=node.parameters,n=prefix(node),legacy=`${n}_resume`,state=`${n}_resume_state`;
  const values=await snapshot(service);
  const write=async(name:string,type:VariableValueType,value:unknown)=>{
    const entry={variable:new URVariable(name,type),value};
    if(Object.hasOwn(values,name))await service.setVariable(entry);else await service.createVariable(entry);
  };
  if(reset){
    const cursor=cursorForStartItem(p.recipe,p.startItem??1);
    // The pair is authoritative; the integer remains a backward-compatible mirror.
    await write(state,VariableValueType.ARRAY,[cursor,-1]);
    await write(legacy,VariableValueType.INTEGER,cursor);
    p.resumeVariable=legacy;p.resumeRevision=p.recipe.revision;
  }else{
    // Migration must import the actual controller value on first execution;
    // a stored application snapshot can lag the live shared variable.
    if(p.resumeVariable!==legacy||!Object.hasOwn(values,legacy))return;
    if(!Object.hasOwn(values,state))await write(state,VariableValueType.ARRAY,[-1,-1]);
  }
  p.resumeStateVariable=state;
}
