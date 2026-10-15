// Exercise exported modules against a loopback-only protocol fixture.
// This does not assert successful use of a commercial provider account.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const candidate=path.resolve(process.argv[2]), data=fs.mkdtempSync(path.join(os.tmpdir(),'offercrew-key-protocol-'));
const contentSha256=JSON.parse(fs.readFileSync(path.join(candidate,'CLIENT-MANIFEST.json'))).contentSha256;
const key=crypto.randomBytes(32).toString('hex'), checks=[], requests=[];
const save=(p,x)=>{fs.mkdirSync(path.dirname(path.join(data,p)),{recursive:true});fs.writeFileSync(path.join(data,p),JSON.stringify(x),{mode:0o600});};
const mark=name=>checks.push({name,passed:true});
let reject=false, server;
try {
  process.env.RADAR_ROOT=data;delete process.env.RADAR_SANDBOX;delete process.env.NODE_TEST_CONTEXT;
  const initialized=spawnSync(process.execPath,[path.join(candidate,'bin/data-root.mjs'),data],{env:process.env,encoding:'utf8'});assert.equal(initialized.status,0);
  server=http.createServer(async(req,res)=>{
    const buffers=[];for await(const b of req)buffers.push(b);
    const body=JSON.parse(Buffer.concat(buffers));
    requests.push({path:req.url,model:body.model,authenticated:req.headers.authorization===`Bearer ${key}`||req.headers['x-api-key']===key});
    res.setHeader('content-type','application/json');
    if(reject){res.writeHead(400);return res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'fixture rejected credential '+key}}));}
    const answer=JSON.stringify({ok:true,marker:'byok-protocol'});
    if(req.url==='/v1/messages')return res.end(JSON.stringify({id:'fixture-message',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:answer}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}));
    if(req.url==='/v1/responses')return res.end(JSON.stringify({id:'fixture-response',model:body.model,status:'completed',output_text:answer,usage:{input_tokens:1,output_tokens:1}}));
    res.end(JSON.stringify({model:body.model,choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/v1`;
  save('private/providers/fixture.auth.json',{base_url:base,auth_token:key});
  const {infer}=await import(pathToFileURL(path.join(candidate,'lib/model.mjs')).href);
  const {modelErrorFilter,recordModelVerification}=await import(pathToFileURL(path.join(candidate,'lib/model-verification.mjs')).href);
  const schema={type:'object',properties:{ok:{type:'boolean'},marker:{type:'string'}},required:['ok','marker'],additionalProperties:false};
  for(const [kind,wire,route] of [['openai_http','chat','/v1/chat/completions'],['openai_http','responses','/v1/responses'],['anthropic_http',null,'/v1/messages']]){
    const provider={kind,models:['client-fixture'],auth_file:'private/providers/fixture.auth.json',...(wire?{wire_api:wire}:{})};
    save('config/providers.json',{providers:{fixture:provider}});
    save('config/model.json',{text:{driver:'backends',backends:[{provider:'fixture',model:'client-fixture'}],max_tokens:128,timeout_ms:5000},concurrency:1});
    const output=await infer('Return the fixture JSON.','source-key-protocol',schema,{persist:false});
    assert.deepEqual(output,{ok:true,marker:'byok-protocol'});
    assert.equal(requests.at(-1).path,route);assert.equal(requests.at(-1).authenticated,true);assert.equal(requests.at(-1).model,'client-fixture');
    mark('loopback-'+kind+'-'+(wire||'messages'));
  }
  reject=true;
  let failure;try{await infer('Return the fixture JSON.','source-key-error',schema,{persist:false});}catch(e){failure=e;}
  assert.ok(failure);assert.match(failure.message,/claude_api_400/);
  const provider={kind:'anthropic_http',models:['client-fixture'],auth_file:'private/providers/fixture.auth.json'};
  const filter=modelErrorFilter(provider), shown=filter(failure);assert.ok(!shown.includes(key));assert.ok(shown.includes('[已隐藏]'));
  const row=recordModelVerification('fixture/client-fixture',{ok:false,error:failure},{providers:{fixture:provider}});
  assert.equal(row.ok,false);assert.ok(!row.error.includes(key));
  mark('provider-error-and-credential-redaction');
  console.log(JSON.stringify({schema:1,ok:true,contentSha256,checks,realProviderSuccess:false,loopbackRequests:requests.length,externalRequests:0,productionWrites:false}));
}catch(e){console.log(JSON.stringify({schema:1,ok:false,contentSha256,checks,realProviderSuccess:false,error:String(e.message).split(key).join('[hidden]').slice(0,400)}));process.exitCode=1;}
finally{if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(data,{recursive:true,force:true});}
