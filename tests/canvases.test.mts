import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'pithagoras-canvas-test-'));
const {getDb}=await import('../server/src/db.js');
const {CanvasTools,canvasWritePrefix}=await import('../server/src/pi/canvas-tools.js');
const {readCanvas,editCanvas,listCanvases,persistCanvas}=await import('../server/src/canvases.js');
getDb().prepare('INSERT INTO sessions (id,title,workspace) VALUES (?,?,?)').run('s1','test','/tmp');
getDb().prepare('INSERT INTO sessions (id,title,workspace) VALUES (?,?,?)').run('s2','other','/tmp');
function setup(){const controller=new CanvasTools('s1');const tools:Record<string,any>={};controller.extension({registerTool:(t:any)=>tools[t.name]=t} as any);return {controller,tools};}
const value=(r:any)=>{assert.equal(r.content[0].type,'text');return JSON.parse(r.content[0].text)};
function delta(controller:any,id:string,raw:string){controller.observe({type:'message_update',assistantMessageEvent:{type:'toolcall_delta',contentIndex:0,delta:raw,partial:{content:[{type:'toolCall',name:'canvas_write',id}]}}});}
test('partial JSON decoder preserves escapes and does not invent incomplete Unicode',()=>{
 assert.deepEqual(canvasWritePrefix('{"canvas_id":"abc","revision":0,"operation":"replace","content":"hello\\nworld\\u26'),{canvas_id:'abc',revision:0,operation:'replace',content:'hello\nworld'});
 assert.equal(canvasWritePrefix('{"canvas_id":"abc') ,undefined);
 assert.equal(canvasWritePrefix('{"canvas_id":"abc","revision":0,"operation":"append","content":"quote: \\" yes')?.content,'quote: " yes');
});
test('streamed content is retained in memory before execution and survives interruption; appending does not duplicate',async()=>{
 const {controller,tools}=setup();const row=value(await tools.canvas_create.execute('create',{title:'Document'}));
 delta(controller,'write',`{"canvas_id":"${row.id}","revision":0,"operation":"replace","content":"First`);
 assert.equal(readCanvas('s1',row.id).content,'First');assert.equal(readCanvas('s1',row.id).status,'writing');
 delta(controller,'write',' line\\nSecond');controller.interrupt();
 let saved=readCanvas('s1',row.id);assert.equal(saved.content,'First line\nSecond');assert.equal(saved.status,'interrupted');assert.equal(saved.active_call,null);
 saved=value(await tools.canvas_read.execute('read',{canvas_id:row.id}));
 const args={canvas_id:row.id,revision:saved.revision,operation:'append',content:' paragraph.'};
 delta(controller,'append',JSON.stringify(args));value(await tools.canvas_write.execute('append',args));
 assert.equal(readCanvas('s1',row.id).content,'First line\nSecond paragraph.');
});
test('manual edits require a new read, even if the AI guesses the latest revision',async()=>{
 const {controller,tools}=setup();let row=value(await tools.canvas_create.execute('create',{title:'Human edits'}));
 row=editCanvas('s1',row.id,row.revision,row.title,'Human words');assert.equal(row.status,'edited');
 const args={canvas_id:row.id,revision:row.revision,operation:'replace',content:'AI words'};
 await assert.rejects(tools.canvas_write.execute('stale',args),/Read this canvas/);
 assert.equal(readCanvas('s1',row.id).content,'Human words');
 value(await tools.canvas_read.execute('read',{canvas_id:row.id}));value(await tools.canvas_write.execute('fresh',args));assert.equal(readCanvas('s1',row.id).content,'AI words');
 controller.interrupt();
});
test('future revisions recover during streaming and execution without bypassing edit guards',async()=>{
 const {controller,tools}=setup();const row=value(await tools.canvas_create.execute('create',{title:'Future revision'}));
 const args={canvas_id:row.id,revision:100,operation:'replace',content:'First line'};
 delta(controller,'future',`{"canvas_id":"${row.id}","revision":100,"operation":"replace","content":"First`);
 assert.equal(readCanvas('s1',row.id).content,'First');
 value(await tools.canvas_read.execute('read-active',{canvas_id:row.id}));
 await assert.rejects(tools.canvas_write.execute('concurrent',args),/being written/);
 delta(controller,'future',' line"}');
 const result=value(await tools.canvas_write.execute('future',args));
 assert.equal(result.revision,readCanvas('s1',row.id).revision);
 assert.equal(readCanvas('s1',row.id).content,'First line');
 assert.equal(readCanvas('s1',row.id).active_call,null);
 await assert.rejects(tools.canvas_write.execute('stale',{...args,revision:0}),/current revision/);
 value(await tools.canvas_write.execute('direct',{...args,operation:'append',content:' again'}));
 let current=readCanvas('s1',row.id);
 assert.equal(current.content,'First line again');
 current=editCanvas('s1',row.id,current.revision,current.title,'Human edit');
 await assert.rejects(tools.canvas_write.execute('unread',args),/Read this canvas/);
 assert.equal(readCanvas('s1',row.id).content,'Human edit');
});
test('session scope and revision checks protect other documents and active writes',async()=>{
 const {controller,tools}=setup();const row=value(await tools.canvas_create.execute('create',{title:'Scoped'}));
 assert.throws(()=>readCanvas('s2',row.id),/not found/);assert.equal(listCanvases('s2').length,0);
 delta(controller,'write',`{"canvas_id":"${row.id}","revision":0,"operation":"replace","content":"draft`);
 assert.throws(()=>editCanvas('s1',row.id,1,'Scoped','clobber'),/being written/);
 controller.observe({type:'message_end',message:{stopReason:'aborted'}});
 assert.equal(readCanvas('s1',row.id).status,'interrupted');
 const current=readCanvas('s1',row.id);value(await tools.canvas_delete.execute('delete',{canvas_id:row.id,revision:current.revision}));assert.throws(()=>readCanvas('s1',row.id),/not found/);
});
test('AI can continue its own edits without rereading, including in a resumed controller',async()=>{
 const {tools}=setup();const row=value(await tools.canvas_create.execute('create',{title:'Continue'}));
 const first=value(await tools.canvas_write.execute('one',{canvas_id:row.id,revision:0,operation:'replace',content:'One'}));
 const second=value(await tools.canvas_write.execute('two',{canvas_id:row.id,revision:first.revision,operation:'append',content:' two'}));
 const resumed=setup();value(await resumed.tools.canvas_write.execute('three',{canvas_id:row.id,revision:second.revision,operation:'append',content:' three'}));
 assert.equal(readCanvas('s1',row.id).content,'One two three');
});

test('installed agent runtime forwards canvas data and errors to the next model request',async()=>{
 const {runAgentLoop}=await import(new URL('../node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js',import.meta.resolve('@earendil-works/pi-coding-agent')).href);
 const {tools}=setup();const created=value(await tools.canvas_create.execute('create',{title:'Visible to model'}));
 let calls=0;
 const stream=async(_model:any,context:any)=>{
  calls++;
  if(calls===2){
   const results=context.messages.filter((m:any)=>m.role==='toolResult');
   const listed=results.find((m:any)=>m.toolName==='canvas_list');assert.equal(listed.isError,false);
   assert.ok(JSON.parse(listed.content[0].text).some((row:any)=>row.id===created.id&&row.title==='Visible to model'));
   const missing=results.find((m:any)=>m.toolName==='canvas_read');assert.equal(missing.isError,true);assert.match(missing.content[0].text,/Canvas not found/);
  }
  assert.ok(calls<=2);
  const message={role:'assistant',api:'openai-completions',provider:'test',model:'test',timestamp:Date.now(),usage:{input:0,output:0,totalTokens:0,cost:{input:0,output:0,total:0}},stopReason:calls===1?'toolUse':'stop',content:calls===1?[{type:'toolCall',id:'list',name:'canvas_list',arguments:{}},{type:'toolCall',id:'missing',name:'canvas_read',arguments:{canvas_id:'not-a-real-id'}}]:[{type:'text',text:'I can see the canvas.'}]};
  return {async *[Symbol.asyncIterator](){yield {type:'done',message};},result:async()=>message};
 };
 await runAgentLoop([{role:'user',content:'List canvases',timestamp:Date.now()}],{systemPrompt:'',messages:[],tools:Object.values(tools)},{model:{id:'test',provider:'test',api:'openai-completions'},convertToLlm:(messages:any)=>messages},()=>{},undefined,stream);
 assert.equal(calls,2);
});


test('temporary canvases never reach SQLite until stored, including mid-stream; future edits auto-save',async()=>{
 const {controller,tools}=setup();const row=value(await tools.canvas_create.execute('temp',{title:'Temporary'}));
 const stored=()=>getDb().prepare('SELECT * FROM canvases WHERE id=?').get(row.id) as any;
 assert.equal(row.persisted,false);assert.equal(stored(),undefined);
 delta(controller,'live',`{"canvas_id":"${row.id}","revision":0,"operation":"replace","content":"Draft`);
 assert.equal(stored(),undefined);
 assert.throws(()=>persistCanvas('s2',row.id),/not found/);
 const saved=persistCanvas('s1',row.id);assert.equal(saved.persisted,true);assert.equal(stored().content,'Draft');
 assert.equal(persistCanvas('s1',row.id).id,row.id);assert.equal(listCanvases('s1').filter(r=>r.id===row.id).length,1);
 delta(controller,'live',' continues');controller.interrupt();
 assert.equal(stored().content,'Draft continues');assert.equal(stored().active_call,null);
 const current=readCanvas('s1',row.id);editCanvas('s1',row.id,current.revision,'Stored','Human edit');
 assert.equal(stored().content,'Human edit');
 const fresh=value(await tools.canvas_read.execute('read',{canvas_id:row.id}));
 const result=value(await tools.canvas_write.execute('later',{canvas_id:row.id,revision:fresh.revision,operation:'append',content:' and AI'}));
 assert.equal(result.persisted,true);assert.equal(stored().content,'Human edit and AI');
});
test('a streamed write is one revision however many pieces it arrives in',async()=>{
 const {controller,tools}=setup();const row=value(await tools.canvas_create.execute('create',{title:'Streamed'}));
 const args={canvas_id:row.id,revision:0,operation:'replace',content:''};
 const raw=JSON.stringify({...args,content:'word '.repeat(200)});
 const head=raw.slice(0,raw.indexOf('"content":"')+11);
 delta(controller,'draft',head);
 for(const piece of raw.slice(head.length).match(/.{1,5}/g)!)delta(controller,'draft',piece);
 assert.equal(readCanvas('s1',row.id).revision,1);
 const first=value(await tools.canvas_write.execute('draft',{...args,content:'word '.repeat(200)}));
 assert.equal(first.revision,1);
 const next={canvas_id:row.id,revision:1,operation:'append',content:'more words '.repeat(50)};
 const raw2=JSON.stringify(next);
 for(const piece of raw2.match(/.{1,7}/g)!)delta(controller,'second',piece);
 assert.equal(value(await tools.canvas_write.execute('second',next)).revision,2);
});
