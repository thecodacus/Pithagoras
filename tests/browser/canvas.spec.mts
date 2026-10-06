import { test, expect } from './portal-mock';
test('canvas streams on the stage, retains a partial draft and supports inline edits and deletion',async({page})=>{
 const failures:string[]=[];page.on('pageerror',e=>failures.push(e.message));
 await page.route('**/api/browser',r=>r.fulfill({json:{running:false,install:{container:'stopped'},sessions:[]}}));
 let deleted=false;
 await page.route('**/api/sessions/test/canvases',r=>r.fulfill({json:deleted?[]:[row]}));
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:false}}));
 await page.route('**/api/sessions/test/commands',r=>r.fulfill({json:{commands:[]}}));
 await page.route('**/api/sessions/test/config',r=>r.fulfill({status:503,json:{}}));
 let row={id:'canvas-1',title:'A live document',content:'',revision:0,status:'writing',active_call:'call-1',updated_at:'',persisted:false};
 await page.route('**/api/sessions/test/canvases/canvas-1',async route=>{
   if(route.request().method()==='DELETE'){deleted=true;return route.fulfill({json:{ok:true}});}
   const body=route.request().postDataJSON();expect(body.revision).toBe(row.revision);row={...row,...body,revision:row.revision+1,status:'edited',active_call:null as any};return route.fulfill({json:row});
 });
 await page.route('**/api/sessions/test/canvases/canvas-1/persist',r=>{row={...row,persisted:true};return r.fulfill({json:row});});
 await page.goto('/tests/voice.html');
 await expect(page.getByLabel('Session canvases')).toBeVisible();
 // What the chat's stream passes on once it is up: see canvas-feed.ts.
 await page.evaluate(()=>{(window as any).canvasFeed.connected(true);(window as any).canvasFeed.message({type:'snapshot',canvases:[]});});
 const emit=async()=>page.evaluate(row=>(window as any).canvasFeed.message({type:'update',canvas:row}),row);
 // Creation should open the panel before the first write.
 await page.evaluate(row=>(window as any).canvasFeed.message({type:'create',canvas:{...row,status:'saved',active_call:null}}),row);
 await expect(page.getByLabel('Session canvas workspace')).toBeVisible();
 await page.getByLabel('Close canvas',{exact:true}).click();
 row.content='# A live document\n\nThe first sentence.';row.revision=1;await emit();
 await expect(page.getByLabel('Session canvas workspace')).toBeVisible();
 await expect(page.locator('.canvas-document')).toContainText('The first sentence.');
 await expect(page.getByRole('button',{name:'Edit inline'})).toBeDisabled();
 row.content+=' Another sentence appears.';row.revision=2;await emit();
 await expect(page.locator('.canvas-document')).toContainText('Another sentence appears.');
 row.status='interrupted';row.active_call=null as any;await emit();
 await expect(page.getByText('Partial draft retained',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Edit inline'}).click();
 await page.getByLabel('Edit canvas content').fill('My own edited document.');
 await page.getByLabel('Canvas title').fill('Human revision');
 await page.getByRole('button',{name:'Apply changes'}).click();
 await expect(page.locator('.canvas-document')).toContainText('My own edited document.');
 await expect(page.getByText('Edited by you',{exact:false})).toBeVisible();
 const downloadEvent=page.waitForEvent('download');await page.getByLabel('Download canvas',{exact:true}).click();expect((await downloadEvent).suggestedFilename()).toBe('Human revision.md');
 await page.getByLabel('Store canvas',{exact:true}).click();await expect(page.getByLabel('Canvas stored',{exact:true})).toBeDisabled();
 await page.setViewportSize({width:390,height:844});
 // Its width animates to the new viewport: measured once it has got there.
 await expect.poll(async()=>{const box=await page.getByLabel('Session canvas workspace').boundingBox();return box!.x>=0&&box!.x+box!.width<=390;}).toBe(true);
 await page.getByLabel('Delete canvas').click();await page.getByRole('button',{name:'Delete',exact:true}).click();
 await expect(page.getByText('A place for your documents')).toBeVisible();
 await page.evaluate(()=>(window as any).canvasFeed.message({type:'focus',canvas:{id:'read-doc',title:'Document being read',content:'The AI is reading this document.',revision:1,status:'saved',active_call:null}}));
 await expect(page.getByLabel('Select canvas')).toHaveText('Document being read');
 await expect(page.locator('.canvas-document')).toContainText('The AI is reading this document.');expect(failures).toEqual([]);
});

test('saved canvas list loads even when its live stream is disconnected',async({page})=>{
 await page.route('**/api/browser',r=>r.fulfill({json:{running:false,install:{container:'stopped'},sessions:[]}}));
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:false}}));
 await page.route('**/api/sessions/test/commands',r=>r.fulfill({json:{commands:[]}}));
 await page.route('**/api/sessions/test/config',r=>r.fulfill({status:503,json:{}}));
 await page.route('**/api/sessions/test/canvases',r=>r.fulfill({json:[{id:'saved',title:'Saved document',content:'Persisted words',revision:1,status:'saved',active_call:null}]}));
 await page.goto('/tests/voice.html');
 await page.getByLabel('Session canvases',{exact:true}).click();
 await expect(page.getByLabel('Select canvas')).toHaveText('Saved document');
 await expect(page.locator('.canvas-document')).toContainText('Persisted words');
 await expect(page.getByText('Reconnecting to live canvas…')).toBeVisible();
});

test('a canvas deleted while it is being edited ends the edit, and its draft stays to be copied',async({page})=>{
 await page.route('**/api/browser',r=>r.fulfill({json:{running:false,install:{container:'stopped'},sessions:[]}}));
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:false}}));
 await page.route('**/api/sessions/test/commands',r=>r.fulfill({json:{commands:[]}}));
 await page.route('**/api/sessions/test/config',r=>r.fulfill({status:503,json:{}}));
 await page.route('**/api/sessions/test/canvases',r=>r.fulfill({json:[]}));
 await page.goto('/tests/voice.html');
 const row={id:'canvas-1',title:'A document',content:'Written by the agent.',revision:1,status:'saved',active_call:null,updated_at:'',persisted:false};
 await page.evaluate(row=>{(window as any).canvasFeed.connected(true);(window as any).canvasFeed.message({type:'snapshot',canvases:[row]});},row);
 await page.getByLabel('Session canvases',{exact:true}).click();
 await page.getByRole('button',{name:'Edit inline'}).click();
 await page.getByLabel('Edit canvas content').fill('Half of my own text.');
 // Gone: the agent removed it, or another tab did.
 await page.evaluate(()=>(window as any).canvasFeed.message({type:'delete',id:'canvas-1'}));
 await expect(page.getByRole('alert')).toContainText('This document was deleted while you were editing it.');
 await expect(page.getByLabel('Your draft')).toHaveValue('Half of my own text.');
 // Not stuck: the panel can be closed and another document made.
 await expect(page.getByLabel('New canvas')).toBeEnabled();
 await expect(page.getByLabel('Close canvas',{exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Dismiss'}).click();
 await expect(page.getByLabel('Your draft')).toHaveCount(0);
 await page.getByLabel('Close canvas',{exact:true}).click();
 await expect(page.getByLabel('Session canvas workspace')).toHaveCount(0);
});

test('a document that a cut-off write left half done can be put back as it was',async({page})=>{
 await page.route('**/api/browser',r=>r.fulfill({json:{running:false,install:{container:'stopped'},sessions:[]}}));
 await page.route('**/api/voice',r=>r.fulfill({json:{enabled:false}}));
 await page.route('**/api/sessions/test/commands',r=>r.fulfill({json:{commands:[]}}));
 await page.route('**/api/sessions/test/config',r=>r.fulfill({status:503,json:{}}));
 await page.route('**/api/sessions/test/canvases',r=>r.fulfill({json:[]}));
 let asked:any;
 await page.route('**/api/sessions/test/canvases/canvas-1/restore',r=>{
  asked=r.request().postDataJSON();
  return r.fulfill({json:{id:'canvas-1',title:'A document',content:'The whole of the document.',revision:4,status:'edited',active_call:null,updated_at:'',persisted:true,restorable:false}});
 });
 await page.goto('/tests/voice.html');
 const row={id:'canvas-1',title:'A document',content:'The wh',revision:3,status:'interrupted',active_call:null,updated_at:'',persisted:true,restorable:true};
 await page.evaluate(row=>{(window as any).canvasFeed.connected(true);(window as any).canvasFeed.message({type:'snapshot',canvases:[row]});},row);
 await page.getByLabel('Session canvases',{exact:true}).click();
 const restore=page.getByRole('button',{name:'Restore the version before the interrupted write'});
 await expect(restore).toBeEnabled();
 // Not while the agent is writing, and not when there is nothing to go back to.
 await page.evaluate(row=>(window as any).canvasFeed.message({type:'update',canvas:row}),{...row,status:'writing',active_call:'call-2'});
 await expect(restore).toHaveCount(0);
 await page.evaluate(row=>(window as any).canvasFeed.message({type:'update',canvas:row}),{...row,restorable:false});
 await expect(restore).toHaveCount(0);
 await page.evaluate(row=>(window as any).canvasFeed.message({type:'update',canvas:row}),row);
 await restore.click();
 expect(asked).toEqual({revision:3});
 await expect(page.locator('.canvas-document')).toContainText('The whole of the document.');
 await expect(restore).toHaveCount(0);
});
