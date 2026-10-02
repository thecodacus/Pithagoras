import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {startLlamaProxy,proxyBaseUrl,forgetSession,modelLoaded} from '../server/src/llama-progress.ts';
test('progress survives split SSE packets while response is forwarded unchanged',async()=>{
 const frames='data: {"prompt_progress":{"total":100,"processed":40,"cache":10,"time_ms":200}}\n\ndata: [DONE]\n\n';
 const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(404).end();return;}let body='';req.on('data',c=>body+=c);req.on('end',()=>{assert.equal(JSON.parse(body).return_progress,true);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(frames.slice(0,35));setTimeout(()=>res.end(frames.slice(35)),30);});});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const received:any[]=[];startLlamaProxy((id,p)=>received.push({id,...p}));
 await new Promise(resolve=>setTimeout(resolve,20));
 const origin=`http://127.0.0.1:${(upstream.address() as any).port}`;
 try {const base=proxyBaseUrl('test-progress',origin);assert.ok(base);const r=await fetch(base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({stream:true,model:'test'})});assert.equal(await r.text(),frames);assert.deepEqual(received,[{id:'test-progress',total:100,processed:40,cache:10,timeMs:200}]);}
 finally{forgetSession('test-progress');upstream.closeAllConnections();upstream.close();}
});
test('a model that is not loaded yet is reported as loading, then ready once it answers',async()=>{
 let loaded=false;
 const upstream=http.createServer((req,res)=>{
  if(req.url==='/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'big',status:{value:loaded?'loaded':'loading'}}]}));return;}
  req.resume();req.on('end',()=>setTimeout(()=>{loaded=true;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: [DONE]\n\n');},150));
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 startLlamaProxy(()=>{});
 await new Promise(resolve=>setTimeout(resolve,20));
 const origin=`http://127.0.0.1:${(upstream.address() as any).port}`;
 try{
  assert.equal(await modelLoaded(origin,'big'),false);
  const base=proxyBaseUrl('test-load',origin)!;
  await (await fetch(base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({stream:true,model:'big'})})).text();
  assert.equal(await modelLoaded(origin,'big'),true);
  assert.equal(await modelLoaded(origin,'other'),undefined);
 }finally{forgetSession('test-load');upstream.closeAllConnections();upstream.close();}
});
test('a plain llama-server that reports no load state is not asked again on every request',async()=>{
 let asked=0;
 const upstream=http.createServer((req,res)=>{
  asked++;
  if(req.url==='/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'one'}]}));return;}
  res.writeHead(404).end();
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const origin=`http://127.0.0.1:${(upstream.address() as any).port}`;
 try{
  assert.equal(await modelLoaded(origin,'one'),undefined);
  assert.equal(asked,2,'the router and llama-swap routes, once');
  assert.equal(await modelLoaded(origin,'one'),undefined);
  assert.equal(asked,2);
 }finally{upstream.closeAllConnections();upstream.close();}
});
test('a load that fails before a byte comes back still ends, so the chat does not wait on it for ever',async()=>{
 const upstream=http.createServer((req,res)=>{
  if(req.url==='/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'gone',status:{value:'unloaded'}}]}));return;}
  req.resume();req.on('end',()=>setTimeout(()=>res.destroy(),150));
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const models:any[]=[];startLlamaProxy(()=>{},(id,load)=>models.push({id,...load}));
 await new Promise(resolve=>setTimeout(resolve,20));
 const origin=`http://127.0.0.1:${(upstream.address() as any).port}`;
 try{
  const base=proxyBaseUrl('test-fail',origin)!;
  const r=await fetch(base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({stream:true,model:'gone'})});
  assert.equal(r.status,502);await r.text();
  assert.deepEqual(models.filter(m=>m.id==='test-fail').map(m=>m.state),['loading','ready']);
 }finally{forgetSession('test-fail');upstream.closeAllConnections();upstream.close();}
});
test('a server that wants a key is asked with the request\'s key, and a refusal is not taken for silence',async()=>{
 const seen:(string|undefined)[]=[];
 const upstream=http.createServer((req,res)=>{
  seen.push(req.headers.authorization);
  if(req.headers.authorization!=='Bearer k'){res.writeHead(401).end();return;}
  if(req.url==='/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'m',status:{value:'unloaded'}}]}));return;}
  res.writeHead(404).end();
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const origin=`http://127.0.0.1:${(upstream.address() as any).port}`;
 try{
  assert.equal(await modelLoaded(origin,'m'),undefined,'no key: refused');
  assert.equal(await modelLoaded(origin,'m',{authorization:'Bearer k'}),false,'asked again, with the key');
  assert.equal(seen.at(-1),'Bearer k');
 }finally{upstream.closeAllConnections();upstream.close();}
});
test('a model found loaded is not asked about again on every step of a run, and a swap asks again',async()=>{
 let asked=0;
 const upstream=http.createServer((req,res)=>{
  asked++;
  if(req.url==='/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'a',status:{value:'loaded'}},{id:'b',status:{value:'loaded'}}]}));return;}
  res.writeHead(404).end();
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const origin=`http://127.0.0.1:${(upstream.address() as any).port}`;
 try{
  assert.equal(await modelLoaded(origin,'a'),true);
  assert.equal(await modelLoaded(origin,'a'),true);
  assert.equal(asked,1);
  assert.equal(await modelLoaded(origin,'b'),true);
  assert.equal(await modelLoaded(origin,'a'),true);
  assert.equal(asked,3,'another model in between may have swapped it out');
  assert.equal(await modelLoaded(origin,'alias'),undefined);
  const after=asked;
  assert.equal(await modelLoaded(origin,'alias'),undefined);
  assert.equal(asked,after,'a model the router does not list is left alone for a while');
 }finally{upstream.closeAllConnections();upstream.close();}
});
test('llama-swap: a model up is loaded, one down is not, and an alias is not taken for down',async()=>{
 const upstream=http.createServer((req,res)=>{
  const json=(body:unknown)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  if(req.url==='/running')return json({running:[{model:'qwen',state:'ready'}]});
  if(req.url==='/v1/models')return json({object:'list',data:[{id:'qwen'},{id:'llama'}]});
  res.writeHead(404).end();
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const origin=`http://127.0.0.1:${(upstream.address() as any).port}`;
 try{
  assert.equal(await modelLoaded(origin,'llama'),false);
  assert.equal(await modelLoaded(origin,'qwen'),true);
  assert.equal(await modelLoaded(origin,'fast'),undefined,'an alias: what it stands for is not said');
 }finally{upstream.closeAllConnections();upstream.close();}
});
test('llama-server\'s timings on the last chunk are passed on as they are, and the stream is untouched',async()=>{
 const frames='data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"timings":{"cache_n":40,"prompt_n":15,"prompt_ms":250.5,"prompt_per_second":59.9,"predicted_n":20,"predicted_ms":556.9,"predicted_per_second":35.9,"draft_n":19,"draft_n_accepted":11}}\n\ndata: [DONE]\n\n';
 const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(frames);});});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const timings:any[]=[];startLlamaProxy(()=>{},undefined,(id,t)=>timings.push({id,...t}));
 await new Promise(resolve=>setTimeout(resolve,20));
 const origin=`http://127.0.0.1:${(upstream.address() as any).port}`;
 try{
  const base=proxyBaseUrl('test-timings',origin)!;
  assert.equal(await (await fetch(base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({stream:true,model:'m'})})).text(),frames);
  assert.deepEqual(timings,[{id:'test-timings',promptTokens:15,cachedTokens:40,promptMs:250.5,promptPerSecond:59.9,outputTokens:20,outputMs:556.9,outputPerSecond:35.9,draftTokens:19,draftAccepted:11}]);
 }finally{forgetSession('test-timings');upstream.closeAllConnections();upstream.close();}
});
