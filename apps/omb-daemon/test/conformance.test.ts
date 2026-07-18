import assert from "node:assert/strict";
import net, {type Socket} from "node:net";
import {createHash,randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import test from "node:test";
import {parseStartupRecord,type CameraPlanV1} from "@oh-my-blender/protocol";
import {start,type DaemonOptions} from "../src/daemon.ts";

const key="AAAAAAAAAAAAAAAAAAAAAA==", nonce=()=>Buffer.alloc(16,Math.floor(Math.random()*255)).toString("base64url");
const hello=(n=nonce())=>({type:"hello",protocol:1,addon_version:"1",blender_version:"4",project_id:randomUUID(),client_nonce:n});
const helloV2=(n=nonce())=>({type:"hello",protocol:2,addon_version:"1",blender_version:"4",project_id:randomUUID(),client_nonce:n,capabilities:["mutation_bridge_v2"]});
const request=(over:Record<string,unknown>={})=>({type:"request",id:randomUUID(),method:"ok",params:{},expected_revision_id:"0".repeat(64),deadline_ms:1000,...over});
const bridgePlan=():CameraPlanV1=>({schema_version:1,expected_revision_id:"0".repeat(64),evidence_sha256:"a".repeat(64),output_format:{width:1,height:1},keyframes:[{frame:1,pose:{position:[0,0,1],look_at:[0,0,0],up:[0,1,0],vertical_fov_radians:0.5},transition:"smooth"}]});
function frame(value:unknown,{masked=true,fin=true,opcode=1,rsv=0}:{masked?:boolean;fin?:boolean;opcode?:number;rsv?:number}={}){const p=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));const ext=p.length<126?0:p.length<65536?2:8,h=Buffer.alloc(2+ext+(masked?4:0));h[0]=(fin?128:0)|(rsv&0x70)|opcode;h[1]=(masked?128:0)|(ext===0?p.length:ext===2?126:127);if(ext===2)h.writeUInt16BE(p.length,2);if(ext===8)h.writeBigUInt64BE(BigInt(p.length),2);if(masked){const o=2+ext;h.fill(7,o,o+4);const q=Buffer.from(p);for(let i=0;i<q.length;i++)q[i]^=7;return Buffer.concat([h,q]);}return Buffer.concat([h,p]);}
class Client{messages:any[]=[];closes:number[]=[];private buf=Buffer.alloc(0);readonly socket:Socket;constructor(socket:Socket){this.socket=socket;socket.on("data",b=>this.read(b));}send(v:unknown,o?:Parameters<typeof frame>[1]){this.socket.write(frame(v,o));}async next(pred=(x:any)=>true,ms=1000){const found=this.messages.find(pred);if(found)return found;return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error("message timeout"));},ms),poll=setInterval(()=>{const x=this.messages.find(pred);if(x){cleanup();resolve(x);}},2);const cleanup=()=>{clearTimeout(timer);clearInterval(poll);};});}private read(b:Buffer){this.buf=Buffer.concat([this.buf,b]);while(this.buf.length>=2){let len=this.buf[1]!&127,o=2;if(len===126){if(this.buf.length<4)return;len=this.buf.readUInt16BE(2);o=4;}else if(len===127){if(this.buf.length<10)return;len=Number(this.buf.readBigUInt64BE(2));o=10;}if(this.buf.length<o+len)return;const op=this.buf[0]!&15,p=this.buf.subarray(o,o+len);this.buf=this.buf.subarray(o+len);if(op===1)this.messages.push(JSON.parse(p.toString()));if(op===8)this.closes.push(p.length>=2?p.readUInt16BE():1000);}}}
async function upgrade(options:Partial<DaemonOptions>={},headers:Record<string,string>={}){const d=await start({port:0,handlers:{ok:async()=>({result:{ok:true},resulting_revision_id:"1".repeat(64)})},stdout:()=>{},...options});const c=await connect(d.port,d.startup.bearer_token,headers);return{d,c};}
function connect(port:number,token:string,headers:Record<string,string>={}){return new Promise<Client>((resolve,reject)=>{const s=net.connect(port,"127.0.0.1",()=>s.write(`GET / HTTP/1.1\r\nHost: ${headers.Host??`127.0.0.1:${port}`}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nAuthorization: ${headers.Authorization??`Bearer ${token}`}\r\n${headers.Origin?`Origin: ${headers.Origin}\r\n`:""}\r\n`));let pre="";const done=(b:Buffer)=>{pre+=b.toString("latin1");if(!pre.includes("\r\n\r\n"))return;if(!pre.startsWith("HTTP/1.1 101")){s.destroy();reject(new Error(pre.split("\r\n")[0]));return;}s.off("data",done);resolve(new Client(s));};s.on("data",done);s.on("error",reject);});}
async function rejected(d:any,headers:Record<string,string>={}){await assert.rejects(connect(d.port,d.startup.bearer_token,headers),/403/);}
async function ready(options:Partial<DaemonOptions>={}){const x=await upgrade(options);x.c.send(hello());await x.c.next(m=>m.type==="hello_ack");return x;}
async function readyV2(options:Partial<DaemonOptions>={}){const x=await upgrade(options);x.c.send(helloV2());const ack=await x.c.next(m=>m.type==="hello_ack");assert.equal(ack.protocol,2);return x;}

for(const [name,headers] of [["wrong token",{Authorization:"Bearer bad"}],["wrong Host",{Host:"localhost"}],["wrong Origin",{Origin:"http://evil"}],["lowercase Authorization scheme",{Authorization:"bearer x"}]] as const)test(`§4 upgrade 403: ${name}; no upgrade`,async()=>{const d=await start({port:0,handlers:{},stdout:()=>{}});try{await rejected(d,headers);}finally{await d.close();}});
test("§4 upgrade 403: expired token",async()=>{let now=0;const d=await start({port:0,clock:{now:()=>now},handlers:{},stdout:()=>{}});try{now=10000;await rejected(d);}finally{await d.close();}});
test("§4 upgrade 403: token reuse and concurrent second socket",async()=>{const {d,c}=await upgrade();try{await rejected(d);assert.equal(c.socket.destroyed,false);}finally{c.socket.destroy();await d.close();}});

test("§4 startup record: child emits exactly one stdout line with matching pid and port",async()=>{const child=spawn(process.execPath,["--import","tsx","src/main.ts","--port","0","--faux"],{cwd:new URL("..",import.meta.url),stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);await new Promise<void>((r,j)=>{const t=setTimeout(()=>j(new Error("startup timeout")),2000);child.stdout.once("data",()=>{clearTimeout(t);setTimeout(r,30);});});const lines=out.trim().split("\n");assert.equal(lines.length,1);const rec=parseStartupRecord(JSON.parse(lines[0]!));assert.equal(rec.pid,child.pid);assert.ok(rec.port>0);assert.equal(err,"");child.kill();await new Promise(r=>child.once("exit",r));});

for(const [name,value] of [["malformed hello",{type:"hello",protocol:2}],["non-hello first message",{type:"ping",nonce:"x"}]] as const)test(`§4 close 1008: ${name}`,async()=>{const {d,c}=await upgrade();try{c.send(value);await new Promise(r=>setTimeout(r,20));assert.deepEqual(c.closes,[1008]);}finally{c.socket.destroy();await d.close();}});
test("§4 close 1008: unmasked client frame",async()=>{const {d,c}=await upgrade();try{c.send(hello(),{masked:false});await new Promise(r=>setTimeout(r,20));assert.deepEqual(c.closes,[1008]);}finally{c.socket.destroy();await d.close();}});
test("§4 close 1008: reserved WebSocket bit",async()=>{const {d,c}=await upgrade();try{c.send(hello());await c.next(m=>m.type==="hello_ack");c.send({type:"ping",nonce:"x"},{rsv:0x40});await new Promise(r=>setTimeout(r,20));assert.deepEqual(c.closes,[1008]);await new Promise<void>(r=>c.socket.closed?r():c.socket.once("close",()=>r()));assert.equal(c.socket.closed,true);}finally{c.socket.destroy();await d.close();}});
test("§4 close 1008: hello later than configured window",async()=>{const {d,c}=await upgrade({helloTimeoutMs:15});try{await new Promise(r=>setTimeout(r,30));assert.deepEqual(c.closes,[1008]);}finally{c.socket.destroy();await d.close();}});
test("§4 hello_ack fields and capabilities",async()=>{const {d,c}=await upgrade();try{c.send(hello());const a=await c.next();assert.equal(a.protocol,1);assert.match(a.session_id,/^[0-9a-f-]{36}$/);assert.match(a.server_nonce,/^[A-Za-z0-9_-]{22}$/);assert.deepEqual(a.capabilities,["inspect_project"]);}finally{c.socket.destroy();await d.close();}});
test("§4 protocol-v2 apply_camera_plan reuses one correlated MutationBridgeSession for progress and result",async()=>{
	const plan={schema_version:1 as const,expected_revision_id:"0".repeat(64),evidence_sha256:"a".repeat(64),output_format:{width:640,height:360},keyframes:[{frame:1,pose:{position:[0,0,50] as [number,number,number],look_at:[0,0,0] as [number,number,number],up:[0,1,0] as [number,number,number],vertical_fov_radians:0.5},transition:"smooth" as const}]};
	const progress:Array<{phase:string;completed:number;total:number}>=[];
	const {d,c}=await readyV2({handlers:{ok:async(_,{applyCameraPlan,signal})=>{
		const result=await applyCameraPlan(plan,{signal,reportProgress:value=>progress.push(value)});
		return{result,resulting_revision_id:"1".repeat(64)};
	}}});
	try{
		const q=request();c.send(q);
		const bridge=await c.next(m=>m.type==="bridge_request");
		assert.equal(bridge.request_id,q.id);assert.equal(bridge.method,"apply_camera_plan");assert.equal(bridge.expected_revision_id,q.expected_revision_id);assert.deepEqual(bridge.params,plan);
		c.send({type:"bridge_progress",id:bridge.id,request_id:q.id,phase:"mutating",completed:1,total:2});
		c.send({type:"bridge_result",id:bridge.id,request_id:q.id,result:{resulting_revision_id:"1".repeat(64)}});
		const response=await c.next(m=>m.type==="response"&&m.id===q.id);
		assert.equal(response.resulting_revision_id,"1".repeat(64));assert.deepEqual(progress,[{phase:"mutating",completed:1,total:2}]);
	}finally{c.socket.destroy();await d.close();}
});

test("G011 existing protocol-v2 bridge assembles bounded artifact chunks and publishes metadata only", async () => {
	const revision = "0".repeat(64);
	const bytes = Buffer.from("connected-render-png");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	let published: Uint8Array | undefined;
	const { d, c } = await readyV2({
		publishArtifact: async (artifact) => {
			assert.equal(artifact.sha256, sha256);
			assert.equal(artifact.byteLength, bytes.byteLength);
			published = artifact.bytes;
			return { sha256, byteLength: bytes.byteLength, uri: `omb-artifact://sha256/${sha256}` };
		},
		handlers: {
			ok: async (_params, { renderQaFrames, signal }) => ({
				result: await renderQaFrames(
					{ schema_version: 1, revision_id: revision, frames: [80] },
					{ signal, reportProgress: () => {} },
				),
				resulting_revision_id: revision,
			}),
		},
	});
	try {
		const q = request({ expected_revision_id: revision });
		c.send(q);
		const bridge = await c.next((message) => message.type === "bridge_request");
		assert.equal(bridge.method, "render_qa_frames");
		const split = 7;
		for (const [chunk_index, chunk] of [bytes.subarray(0, split), bytes.subarray(split)].entries()) {
			c.send({
				type: "bridge_artifact_chunk",
				id: bridge.id,
				request_id: q.id,
				frame: 80,
				chunk_index,
				total_chunks: 2,
				byte_length: chunk.byteLength,
				data_base64: chunk.toString("base64"),
			});
		}
		c.send({
			type: "bridge_result",
			id: bridge.id,
			request_id: q.id,
			result: {
				schema_version: 1,
				revision_id: revision,
				profile_version: "omb-qa-png-v1",
				frames: [{
					frame: 80,
					width: 640,
					height: 360,
					profile_version: "omb-qa-png-v1",
					byte_length: bytes.byteLength,
					sha256,
				}],
			},
		});
		const response = await c.next((message) => message.type === "response" && message.id === q.id);
		assert.deepEqual(Buffer.from(published!), bytes);
		assert.equal(response.result.frames[0].uri, `omb-artifact://sha256/${sha256}`);
		assert.equal("data_base64" in response.result.frames[0], false);
	} finally {
		c.socket.destroy();
		await d.close();
	}
});
test("§4 protocol-v2 top-level cancellation sends bridge_cancel and cannot partially succeed",async()=>{
	let settled=false;
	const {d,c}=await readyV2({handlers:{ok:async(_,{applyCameraPlan,signal})=>{
		try{return{result:await applyCameraPlan(bridgePlan(),{signal,reportProgress:()=>{}}),resulting_revision_id:"1".repeat(64)};}finally{settled=true;}
	}}});
	try{
		const q=request();c.send(q);const bridge=await c.next(m=>m.type==="bridge_request");
		c.send({type:"cancel",id:q.id});
		assert.equal((await c.next(m=>m.type==="cancel_ack"&&m.id===q.id)).status,"accepted");
		const cancel=await c.next(m=>m.type==="bridge_cancel");assert.equal(cancel.id,bridge.id);assert.equal(cancel.request_id,q.id);
		assert.equal((await c.next(m=>m.type==="error"&&m.id===q.id)).code,"CANCELLED");
		c.send({type:"bridge_cancel_ack",id:bridge.id,request_id:q.id,status:"accepted"});
		await new Promise(resolve=>setTimeout(resolve,10));assert.equal(settled,true);
		assert.equal(c.messages.filter(m=>m.id===q.id&&(m.type==="error"||m.type==="response")).length,1);
	}finally{c.socket.destroy();await d.close();}
});
test("§4 protocol-v2 deadline race sends bridge_cancel and only TIMEOUT wins",async()=>{
	const {d,c}=await readyV2({
		handlers:{
			ok:async(_,{applyCameraPlan,signal})=>({
				result:await applyCameraPlan(bridgePlan(),{signal,reportProgress:()=>{}}),
				resulting_revision_id:"1".repeat(64),
			}),
		},
	});
	try{
		const q=request({deadline_ms:100});c.send(q);const bridge=await c.next(m=>m.type==="bridge_request");
		const cancel=await c.next(m=>m.type==="bridge_cancel",300);assert.equal(cancel.id,bridge.id);
		assert.equal((await c.next(m=>m.type==="error"&&m.id===q.id,300)).code,"TIMEOUT");
		c.send({type:"bridge_cancel_ack",id:bridge.id,request_id:q.id,status:"accepted"});
		await new Promise(resolve=>setTimeout(resolve,10));
		assert.equal(c.messages.filter(m=>m.id===q.id&&(m.type==="error"||m.type==="response")).length,1);
	}finally{c.socket.destroy();await d.close();}
});
test("§4 protocol-v2 disconnect rejects the open bridge and drains its handler",async()=>{
	let settled=false;
	const {d,c}=await readyV2({handlers:{ok:async(_,{applyCameraPlan,signal})=>{try{await applyCameraPlan(bridgePlan(),{signal,reportProgress:()=>{}});return{result:{},resulting_revision_id:"1".repeat(64)};}finally{settled=true;}}}});
	const q=request();c.send(q);await c.next(m=>m.type==="bridge_request");c.socket.destroy();
	await Promise.race([d.stopped,new Promise((_,reject)=>setTimeout(()=>reject(new Error("stopped timeout")),2000))]);
	assert.equal(settled,true);
});

for(const n of [99,30001])test(`§4 INVALID_DEADLINE for ${n}`,async()=>{const {d,c}=await ready();try{const q=request({deadline_ms:n});c.send(q);assert.equal((await c.next(m=>m.id===q.id)).code,"INVALID_DEADLINE");}finally{c.socket.destroy();await d.close();}});
for(const n of [100,30000])test(`§4 deadline ${n} is accepted`,async()=>{const {d,c}=await ready();try{const q=request({deadline_ms:n});c.send(q);assert.equal((await c.next(m=>m.id===q.id)).type,"response");}finally{c.socket.destroy();await d.close();}});
test("§4 unknown method is non-retryable METHOD_NOT_ALLOWED",async()=>{const {d,c}=await ready();try{const q=request({method:"nope"});c.send(q);const e=await c.next(m=>m.id===q.id);assert.equal(e.code,"METHOD_NOT_ALLOWED");assert.equal(e.retryable,false);}finally{c.socket.destroy();await d.close();}});
test("§4 handler CODE-prefixed error propagates the typed code",async()=>{const {d,c}=await ready({handlers:{ok:async()=>{throw new Error("STALE_BASE: expected X, current Y");}}});try{const q=request();c.send(q);const e=await c.next(m=>m.id===q.id&&m.type==="error");assert.equal(e.code,"STALE_BASE");assert.equal(e.retryable,false);assert.equal(e.message,"expected X, current Y");}finally{c.socket.destroy();await d.close();}});
test("§4 handler plain error falls back to HANDLER_ERROR",async()=>{const {d,c}=await ready({handlers:{ok:async()=>{throw new Error("something broke");}}});try{const q=request();c.send(q);const e=await c.next(m=>m.id===q.id&&m.type==="error");assert.equal(e.code,"HANDLER_ERROR");assert.equal(e.message,"something broke");}finally{c.socket.destroy();await d.close();}});
test("§4 BUSY for second request while one runs",async()=>{let release!:()=>void;const wait=new Promise<void>(r=>release=r);const {d,c}=await ready({handlers:{ok:async()=>{await wait;return{result:{},resulting_revision_id:"1".repeat(64)}}}});try{const a=request(),b=request();c.send(a);c.send(b);assert.equal((await c.next(m=>m.id===b.id)).code,"BUSY");release();}finally{c.socket.destroy();release();await d.close();}});
test("§4 token bucket burst four, fifth limited, refill",async()=>{let now=0;const {d,c}=await ready({clock:{now:()=>now}});try{for(let i=0;i<4;i++){const q=request({method:"none"});c.send(q);await c.next(m=>m.id===q.id);}const q=request({method:"none"});c.send(q);assert.equal((await c.next(m=>m.id===q.id)).code,"RATE_LIMITED");now=1000;const r=request({method:"none"});c.send(r);assert.equal((await c.next(m=>m.id===r.id)).code,"METHOD_NOT_ALLOWED");}finally{c.socket.destroy();await d.close();}});

test("§4 cancel accepted then one CANCELLED and late resolve is silent",async()=>{let resolve!:any;const p=new Promise<any>(r=>resolve=r);const {d,c}=await ready({handlers:{ok:()=>p}});try{const q=request();c.send(q);c.send({type:"cancel",id:q.id});assert.equal((await c.next(m=>m.type==="cancel_ack")).status,"accepted");assert.equal((await c.next(m=>m.id===q.id&&m.type==="error")).code,"CANCELLED");resolve({result:{},resulting_revision_id:"1".repeat(64)});await new Promise(r=>setTimeout(r,20));assert.equal(c.messages.filter(m=>m.id===q.id&&(m.type==="error"||m.type==="response")).length,1);}finally{c.socket.destroy();await d.close();}});
test("§4 resolve before cancel yields already_terminal and one terminal",async()=>{const {d,c}=await ready();try{const q=request();c.send(q);await c.next(m=>m.type==="response");c.send({type:"cancel",id:q.id});assert.equal((await c.next(m=>m.type==="cancel_ack")).status,"already_terminal");assert.equal(c.messages.filter(m=>m.id===q.id&&(m.type==="error"||m.type==="response")).length,1);}finally{c.socket.destroy();await d.close();}});
test("§4 deadline expiry follows cancellation and emits one TIMEOUT",async()=>{const {d,c}=await ready({handlers:{ok:()=>new Promise(()=>{})}});try{const q=request({deadline_ms:100});c.send(q);assert.equal((await c.next(m=>m.id===q.id&&m.type==="error")).code,"TIMEOUT");assert.equal(c.messages.filter(m=>m.id===q.id&&m.type==="error").length,1);}finally{c.socket.destroy();await d.close();}});
test("§4 handler progress is relayed with request id",async()=>{const {d,c}=await ready({handlers:{ok:async(_,{reportProgress})=>{reportProgress("work",1,2);return{result:{},resulting_revision_id:"1".repeat(64)}}}});try{const q=request();c.send(q);const p=await c.next(m=>m.type==="progress");assert.deepEqual(p,{type:"progress",id:q.id,phase:"work",completed:1,total:2});}finally{c.socket.destroy();await d.close();}});
test("§4 ping pong echoes nonce",async()=>{const {d,c}=await ready();try{c.send({type:"ping",nonce:"abc"});assert.deepEqual(await c.next(m=>m.type==="pong"),{type:"pong",nonce:"abc"});}finally{c.socket.destroy();await d.close();}});
test("§4 ping does not extend request deadline",async()=>{const {d,c}=await ready({handlers:{ok:()=>new Promise(()=>{})}});try{const q=request({deadline_ms:100});c.send(q);for(let i=0;i<3;i++){await new Promise(r=>setTimeout(r,25));c.send({type:"ping",nonce:String(i)});}assert.equal((await c.next(m=>m.id===q.id,300)).code,"TIMEOUT");}finally{c.socket.destroy();await d.close();}});
test("§4 schema-invalid control messages are ignored",async()=>{const {d,c}=await ready();try{c.send({type:"ping",nonce:"bad",extra:true});c.send({type:"cancel",id:7});c.send({type:"shutdown",reason:"bad",extra:true});await new Promise(r=>setTimeout(r,20));assert.equal(c.messages.some(m=>m.type==="pong"||m.type==="cancel_ack"||m.type==="shutdown_ack"),false);assert.equal(c.socket.destroyed,false);}finally{c.socket.destroy();await d.close();}});
test("§4 request id cannot be reused while running or after terminal",async()=>{let release!:()=>void;const wait=new Promise<void>(r=>release=r);let calls=0;const {d,c}=await ready({handlers:{ok:async()=>{calls++;if(calls===1)await wait;return{result:{},resulting_revision_id:"1".repeat(64)}}}});try{const q=request();c.send(q);c.send(q);const running=await c.next(m=>m.id===q.id&&m.type==="error");assert.equal(running.code,"INVALID_REQUEST");assert.equal(running.retryable,false);release();await c.next(m=>m.id===q.id&&m.type==="response");c.messages.splice(0);c.send(q);const terminal=await c.next(m=>m.id===q.id&&m.type==="error");assert.equal(terminal.code,"INVALID_REQUEST");assert.equal(terminal.retryable,false);assert.equal(calls,1);}finally{release();c.socket.destroy();await d.close();}});
test("§4 oversized single text closes 1009",async()=>{const {d,c}=await upgrade();try{c.send(Buffer.alloc(1024*1024+1,65));await new Promise(r=>setTimeout(r,30));assert.deepEqual(c.closes,[1009]);}finally{c.socket.destroy();await d.close();}});
test("§4 fragmented text reassembling over 1 MiB closes 1009",async()=>{const {d,c}=await upgrade();try{c.send(Buffer.alloc(600000,65),{fin:false});c.send(Buffer.alloc(600000,65),{opcode:0});await new Promise(r=>setTimeout(r,30));assert.deepEqual(c.closes,[1009]);}finally{c.socket.destroy();await d.close();}});
test("§4 idle socket closes after configured window",async()=>{const {d,c}=await upgrade({idleTimeoutMs:15});try{await new Promise(r=>setTimeout(r,30));assert.deepEqual(c.closes,[1000]);}finally{c.socket.destroy();await d.close();}});
test("§4 shutdown aborts running request, acknowledges, closes 1000, and server refuses",async()=>{let aborted=false;const {d,c}=await ready({handlers:{ok:async(_,{signal})=>{await new Promise<void>(r=>signal.addEventListener("abort",()=>{aborted=true;r();}));return{result:{},resulting_revision_id:"1".repeat(64)}}}});const q=request();c.send(q);c.send({type:"shutdown",reason:"addon_unload"});await c.next(m=>m.type==="shutdown_ack");await new Promise(r=>setTimeout(r,20));assert.equal(aborted,true);assert.deepEqual(c.closes,[1000]);await assert.rejects(new Promise<void>((resolve,reject)=>{const s=net.connect(d.port,"127.0.0.1",()=>{s.destroy();resolve();});s.on("error",reject);}));await d.close();});
test("§4 shutdown ack and stopped wait for aborted handler settlement",async()=>{let release!:()=>void;let aborted=false,settled=false;const gate=new Promise<void>(r=>release=r);const {d,c}=await ready({handlers:{ok:async(_,{signal})=>{await new Promise<void>(r=>signal.addEventListener("abort",()=>{aborted=true;r();},{once:true}));await gate;settled=true;return{result:{},resulting_revision_id:"1".repeat(64)}}}});const q=request();c.send(q);await new Promise(r=>setTimeout(r,10));c.send({type:"shutdown",reason:"addon_unload"});await new Promise(r=>setTimeout(r,20));assert.equal(aborted,true);assert.equal(settled,false);assert.equal(c.messages.some(m=>m.type==="shutdown_ack"),false);let stopped=false;void d.stopped.then(()=>{stopped=true;});assert.equal(stopped,false);release();await c.next(m=>m.type==="shutdown_ack");await d.stopped;assert.equal(settled,true);assert.equal(stopped,true);assert.deepEqual(c.closes,[1000]);});
test("§4 client_nonce reuse within launch closes 1008",async()=>{const {d,c}=await upgrade();try{const h=hello();c.send(h);await c.next(m=>m.type==="hello_ack");c.send(h);await new Promise(r=>setTimeout(r,20));assert.deepEqual(c.closes,[1008]);}finally{c.socket.destroy();await d.close();}});
test("§4 malformed request consumes a rate-limit token",async()=>{const {d,c}=await ready();try{c.send(Buffer.from("{"));await new Promise(r=>setTimeout(r,5));for(let i=0;i<3;i++){const q=request({method:"none"});c.send(q);assert.equal((await c.next(m=>m.id===q.id)).code,"METHOD_NOT_ALLOWED");}const q=request({method:"none"});c.send(q);assert.equal((await c.next(m=>m.id===q.id)).code,"RATE_LIMITED");}finally{c.socket.destroy();await d.close();}});
test("§4 abrupt client FIN drains the active handler and refuses subsequent TCP connects",async()=>{let aborted=false,settled=false,entered!:()=>void;const enteredP=new Promise<void>(r=>entered=r);const {d,c}=await ready({handlers:{ok:async(_,{signal})=>{entered();await new Promise<void>(r=>signal.addEventListener("abort",()=>{aborted=true;r();},{once:true}));settled=true;return{result:{},resulting_revision_id:"1".repeat(64)}}}});c.send(request());await enteredP;c.socket.destroy();await Promise.race([d.stopped,new Promise((_,reject)=>setTimeout(()=>reject(new Error("stopped timeout")),2000))]);assert.equal(aborted,true);assert.equal(settled,true);await assert.rejects(new Promise<void>((resolve,reject)=>{const s=net.connect(d.port,"127.0.0.1",()=>{s.destroy();resolve();});s.on("error",reject);}));});
test("§4 shutdown waits for a handler started after a prior cancellation, and rejects new requests during drain",async()=>{let releaseA!:()=>void,releaseB!:()=>void,settledA=false,settledB=false,calls=0;const gateA=new Promise<void>(r=>releaseA=r),gateB=new Promise<void>(r=>releaseB=r);const {d,c}=await ready({handlers:{ok:async()=>{calls++;if(calls===1){await gateA;settledA=true;}else{await gateB;settledB=true;}return{result:{},resulting_revision_id:"1".repeat(64)};}}});const qa=request();c.send(qa);c.send({type:"cancel",id:qa.id});assert.equal((await c.next(m=>m.type==="cancel_ack")).status,"accepted");await c.next(m=>m.id===qa.id&&m.type==="error");const qb=request();c.send(qb);await new Promise(r=>setTimeout(r,10));c.send({type:"shutdown",reason:"qa"});await new Promise(r=>setTimeout(r,20));assert.equal(c.messages.some(m=>m.type==="shutdown_ack"),false);const qc=request();c.send(qc);const rejected=await c.next(m=>m.id===qc.id);assert.equal(rejected.code,"SHUTTING_DOWN");assert.equal(rejected.retryable,true);assert.equal(settledA,false);assert.equal(settledB,false);releaseA();await new Promise(r=>setTimeout(r,15));assert.equal(c.messages.some(m=>m.type==="shutdown_ack"),false);assert.equal(settledB,false);releaseB();await c.next(m=>m.type==="shutdown_ack");assert.equal(settledA,true);assert.equal(settledB,true);await d.stopped;});

for (const race of ["cancel", "timeout", "disconnect"] as const) {
	test(`§4 protocol-v2 durable commit owns the terminal outcome against ${race}`, async () => {
		let beginCommit!: () => void;
		let releaseCommit!: () => void;
		const commitStarted = new Promise<void>((resolve) => {
			beginCommit = resolve;
		});
		const commitGate = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		let committed = false;
		const { d, c } = await readyV2({
			handlers: {
				ok: async (_, { applyCameraPlan, beginDurableCommit, signal }) => {
					const result = await applyCameraPlan(bridgePlan(), { signal, reportProgress: () => {} });
					beginDurableCommit();
					beginCommit();
					await commitGate;
					committed = true;
					return { result, resulting_revision_id: "1".repeat(64) };
				},
			},
		});
		const q = request({ deadline_ms: race === "timeout" ? 100 : 1_000 });
		c.send(q);
		const bridge = await c.next((message) => message.type === "bridge_request");
		c.send({
			type: "bridge_result",
			id: bridge.id,
			request_id: q.id,
			result: { resulting_revision_id: "1".repeat(64) },
		});
		await commitStarted;
		if (race === "cancel") {
			c.send({ type: "cancel", id: q.id });
			assert.equal((await c.next((message) => message.type === "cancel_ack")).status, "already_terminal");
		} else if (race === "timeout") {
			await new Promise((resolve) => setTimeout(resolve, 120));
			assert.equal(c.messages.some((message) => message.type === "error" && message.id === q.id), false);
		} else {
			c.socket.destroy();
		}
		releaseCommit();
		if (race === "disconnect") {
			await d.stopped;
		} else {
			const response = await c.next((message) => message.type === "response" && message.id === q.id);
			assert.equal(response.resulting_revision_id, "1".repeat(64));
			assert.equal(c.messages.some((message) => message.type === "error" && message.id === q.id), false);
			c.socket.destroy();
			await d.close();
		}
		assert.equal(committed, true);
	});
}
