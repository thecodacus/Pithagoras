import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// docker.ts reads the socket path when it loads, so it is set before any test imports it.
const dir=mkdtempSync(path.join(tmpdir(),'voice-gpu-'));
process.env.DOCKER_SOCKET=path.join(dir,'docker.sock');
process.env.PORTAL_CONTAINER_NAME='portal-test';

const SMI = '0, GPU-aaaa-0000, NVIDIA GeForce RTX 3060, 12288, 7861\n1, GPU-bbbb-1111, NVIDIA GeForce RTX 3060, 12288, 129\n';

test('nvidia-smi rows become GPUs and anything else is skipped',async()=>{
 const {parseGpus}=await import('../server/src/extensions/voice-service.ts');
 assert.deepEqual(parseGpus(SMI+'Failed to initialize NVML\n'),[
  {index:0,uuid:'GPU-aaaa-0000',name:'NVIDIA GeForce RTX 3060',totalMiB:12288,usedMiB:7861},
  {index:1,uuid:'GPU-bbbb-1111',name:'NVIDIA GeForce RTX 3060',totalMiB:12288,usedMiB:129},
 ]);
 assert.deepEqual(parseGpus(''),[]);
});

test('the container asks for any one GPU until one is chosen, then for that one',async()=>{
 const {containerSpec}=await import('../server/src/extensions/voice-service.ts');
 const any=containerSpec('true','host','');
 assert.deepEqual(any.HostConfig.DeviceRequests,[{Driver:'nvidia',Count:1,Capabilities:[['gpu']]}]);
 assert.equal(any.Labels['pithagoras.voice-gpu'],'');
 const chosen=containerSpec('true','host','GPU-bbbb-1111');
 assert.deepEqual(chosen.HostConfig.DeviceRequests,[{Driver:'nvidia',DeviceIDs:['GPU-bbbb-1111'],Capabilities:[['gpu']]}]);
 assert.equal(chosen.Labels['pithagoras.voice-gpu'],'GPU-bbbb-1111');
});

test('the probe sees every GPU and is removed, and a new GPU recreates the container but keeps the volume',async()=>{
 let container:any={Config:{Labels:{'pithagoras.addon':'voice','pithagoras.voice-network':'shared-v1'}},HostConfig:{NetworkMode:'container:portal-one'},State:{Running:true}};
 let probe:any=null;
 const calls:{method:string;url:string;body:any}[]=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  const body=raw?JSON.parse(raw):undefined;const url=req.url!;const method=req.method!;
  calls.push({method,url,body});res.setHeader('Content-Type','application/json');
  if(url==='/containers/portal-test/json')return res.end(JSON.stringify({Id:'portal-one',State:{Running:true}}));
  if(url==='/containers/pithagoras-voice/json'){res.statusCode=container?200:404;return res.end(JSON.stringify(container));}
  if(url.startsWith('/images/'))return res.end('{}');
  if(url==='/containers/create'){probe=body;return res.end(JSON.stringify({Id:'probe-1'}));}
  if(url.startsWith('/containers/probe-1/logs'))return res.end(JSON.stringify(SMI));
  if(url.includes('/logs?'))return res.end(JSON.stringify('services ready'));
  if(url.includes('/stop?'))container.State.Running=false;
  if(method==='DELETE'&&url==='/containers/pithagoras-voice')container=null;
  if(url.startsWith('/containers/create?name=pithagoras-voice'))container={Config:body,HostConfig:body.HostConfig,State:{Running:false}};
  if(url==='/containers/pithagoras-voice/start')container.State.Running=true;
  res.end('{}');
 });
 await new Promise<void>(r=>server.listen(process.env.DOCKER_SOCKET,r));
 const oldFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
 try {
  const voice=await import('../server/src/extensions/voice-service.ts');
  const found=await voice.gpus();
  assert.deepEqual(found.map(g=>g.uuid),['GPU-aaaa-0000','GPU-bbbb-1111']);
  assert.deepEqual(probe.HostConfig.DeviceRequests,[{Driver:'nvidia',Count:-1,Capabilities:[['gpu']]}]);
  assert.ok(calls.some(c=>c.method==='DELETE'&&c.url.startsWith('/containers/probe-1')));

  voice.useGpu('GPU-bbbb-1111');
  await voice.install();
  for(let n=0;n<200&&!container?.HostConfig?.DeviceRequests;n++)await new Promise(r=>setTimeout(r,10));
  for(let n=0;n<200&&(await voice.status()).busy;n++)await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(container.HostConfig.DeviceRequests,[{Driver:'nvidia',DeviceIDs:['GPU-bbbb-1111'],Capabilities:[['gpu']]}]);
  assert.equal(container.Config.Labels['pithagoras.voice-gpu'],'GPU-bbbb-1111');
  assert.ok(calls.some(c=>c.method==='DELETE'&&c.url==='/containers/pithagoras-voice'));
  assert.ok(!calls.some(c=>c.method==='DELETE'&&c.url.startsWith('/volumes')));

  // The same choice again only starts what is there.
  const before=calls.length;
  await voice.install();
  for(let n=0;n<200&&(await voice.status()).busy;n++)await new Promise(r=>setTimeout(r,10));
  assert.ok(!calls.slice(before).some(c=>c.method==='DELETE'));
 }finally{
  globalThis.fetch=oldFetch;
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  rmSync(dir,{recursive:true,force:true});
 }
});
