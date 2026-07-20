import assert from "node:assert/strict";
import net, {type Socket} from "node:net";
import {createHash,randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import test from "node:test";
import {parseStartupRecord,type CameraPlanV1} from "@oh-my-blender/protocol";
import {start,type DaemonOptions} from "../src/daemon.ts";

const key="AAAAAAAAAAAAAAAAAAAAAA==", nonce=()=>Buffer.alloc(16,Math.floor(Math.random()*255)).toString("base64url");
const QA_PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=","base64");
const hello=(n=nonce())=>({type:"hello",protocol:1,addon_version:"1",blender_version:"4",project_id:randomUUID(),client_nonce:n});
const helloV2=(n=nonce())=>({type:"hello",protocol:2,addon_version:"1",blender_version:"4",project_id:randomUUID(),client_nonce:n,capabilities:["mutation_bridge_v2"]});
const helloV3=(n=nonce())=>({...helloV2(n),capabilities:["mutation_bridge_v2","scene_manifest_v3"]});
const request=(over:Record<string,unknown>={})=>({type:"request",id:randomUUID(),method:"ok",params:{},expected_revision_id:"0".repeat(64),deadline_ms:1000,...over});
const bridgePlan=():CameraPlanV1=>({schema_version:1,expected_revision_id:"0".repeat(64),evidence_sha256:"a".repeat(64),output_format:{width:1,height:1},keyframes:[{frame:1,pose:{position:[0,0,1],look_at:[0,0,0],up:[0,1,0],vertical_fov_radians:0.5},transition:"smooth"}]});
function frame(value:unknown,{masked=true,fin=true,opcode=1,rsv=0}:{masked?:boolean;fin?:boolean;opcode?:number;rsv?:number}={}){const p=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));const ext=p.length<126?0:p.length<65536?2:8,h=Buffer.alloc(2+ext+(masked?4:0));h[0]=(fin?128:0)|(rsv&0x70)|opcode;h[1]=(masked?128:0)|(ext===0?p.length:ext===2?126:127);if(ext===2)h.writeUInt16BE(p.length,2);if(ext===8)h.writeBigUInt64BE(BigInt(p.length),2);if(masked){const o=2+ext;h.fill(7,o,o+4);const q=Buffer.from(p);for(let i=0;i<q.length;i++)q[i]^=7;return Buffer.concat([h,q]);}return Buffer.concat([h,p]);}
class Client{messages:any[]=[];closes:number[]=[];private buf=Buffer.alloc(0);readonly socket:Socket;constructor(socket:Socket){this.socket=socket;socket.on("data",b=>this.read(b));}send(v:unknown,o?:Parameters<typeof frame>[1]){this.socket.write(frame(v,o));}async next(pred=(x:any)=>true,ms=1000){const found=this.messages.find(pred);if(found)return found;return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error("message timeout"));},ms),poll=setInterval(()=>{const x=this.messages.find(pred);if(x){cleanup();resolve(x);}},2);const cleanup=()=>{clearTimeout(timer);clearInterval(poll);};});}private read(b:Buffer){this.buf=Buffer.concat([this.buf,b]);while(this.buf.length>=2){let len=this.buf[1]!&127,o=2;if(len===126){if(this.buf.length<4)return;len=this.buf.readUInt16BE(2);o=4;}else if(len===127){if(this.buf.length<10)return;len=Number(this.buf.readBigUInt64BE(2));o=10;}if(this.buf.length<o+len)return;const op=this.buf[0]!&15,p=this.buf.subarray(o,o+len);this.buf=this.buf.subarray(o+len);if(op===1)this.messages.push(JSON.parse(p.toString()));if(op===8)this.closes.push(p.length>=2?p.readUInt16BE():1000);}}}
async function upgrade(options:Partial<DaemonOptions>={},headers:Record<string,string>={}){const d=await start({port:0,handlers:{ok:async()=>({result:{ok:true},resulting_revision_id:"1".repeat(64)})},stdout:()=>{},...options});const c=await connect(d.port,d.startup.bearer_token,headers);return{d,c};}
function connect(port:number,token:string,headers:Record<string,string>={}){return new Promise<Client>((resolve,reject)=>{const s=net.connect(port,"127.0.0.1",()=>s.write(`GET / HTTP/1.1\r\nHost: ${headers.Host??`127.0.0.1:${port}`}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nAuthorization: ${headers.Authorization??`Bearer ${token}`}\r\n${headers.Origin?`Origin: ${headers.Origin}\r\n`:""}\r\n`));let pre="";const done=(b:Buffer)=>{pre+=b.toString("latin1");if(!pre.includes("\r\n\r\n"))return;if(!pre.startsWith("HTTP/1.1 101")){s.destroy();reject(new Error(pre.split("\r\n")[0]));return;}s.off("data",done);resolve(new Client(s));};s.on("data",done);s.on("error",reject);});}
async function rejected(d:any,headers:Record<string,string>={}){await assert.rejects(connect(d.port,d.startup.bearer_token,headers),/403/);}
async function ready(options:Partial<DaemonOptions>={}){const x=await upgrade(options);x.c.send(hello());await x.c.next(m=>m.type==="hello_ack");return x;}
async function readyV2(options:Partial<DaemonOptions>={}){const x=await upgrade(options);x.c.send(helloV2());const ack=await x.c.next(m=>m.type==="hello_ack");assert.equal(ack.protocol,2);return x;}
async function readyV3(options:Partial<DaemonOptions>={}){const x=await upgrade(options);x.c.send(helloV3());const ack=await x.c.next(m=>m.type==="hello_ack");assert.deepEqual(ack.capabilities,["mutation_bridge_v2","scene_manifest_v3"]);return x;}

for(const [name,headers] of [["wrong token",{Authorization:"Bearer bad"}],["wrong Host",{Host:"localhost"}],["wrong Origin",{Origin:"http://evil"}],["lowercase Authorization scheme",{Authorization:"bearer x"}]] as const)test(`§4 upgrade 403: ${name}; no upgrade`,async()=>{const d=await start({port:0,handlers:{},stdout:()=>{}});try{await rejected(d,headers);}finally{await d.close();}});
test("§4 upgrade 403: expired token",async()=>{let now=0;const d=await start({port:0,clock:{now:()=>now},handlers:{},stdout:()=>{}});try{now=10000;await rejected(d);}finally{await d.close();}});
test("§4 upgrade 403: token reuse and concurrent second socket",async()=>{const {d,c}=await upgrade();try{await rejected(d);assert.equal(c.socket.destroyed,false);}finally{c.socket.destroy();await d.close();}});

test("§4 startup record: child emits exactly one stdout line with matching pid and port",async()=>{const child=spawn(process.execPath,["--import","tsx","src/main.ts","--port","0","--faux"],{cwd:new URL("..",import.meta.url),stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);await new Promise<void>((r,j)=>{const t=setTimeout(()=>j(new Error("startup timeout")),2000);child.stdout.once("data",()=>{clearTimeout(t);setTimeout(r,30);});});const lines=out.trim().split("\n");assert.equal(lines.length,1);const rec=parseStartupRecord(JSON.parse(lines[0]!));assert.equal(rec.pid,child.pid);assert.ok(rec.port>0);assert.equal(err,"");child.kill();await new Promise(r=>child.once("exit",r));});

for(const [name,value] of [["malformed hello",{type:"hello",protocol:2}],["non-hello first message",{type:"ping",nonce:"x"}]] as const)test(`§4 close 1008: ${name}`,async()=>{const {d,c}=await upgrade();try{c.send(value);await new Promise(r=>setTimeout(r,20));assert.deepEqual(c.closes,[1008]);}finally{c.socket.destroy();await d.close();}});
test("§4 close 1008: unmasked client frame",async()=>{const {d,c}=await upgrade();try{c.send(hello(),{masked:false});await new Promise(r=>setTimeout(r,20));assert.deepEqual(c.closes,[1008]);}finally{c.socket.destroy();await d.close();}});
test("§4 close 1008: reserved WebSocket bit",async()=>{const {d,c}=await upgrade();try{c.send(hello());await c.next(m=>m.type==="hello_ack");c.send({type:"ping",nonce:"x"},{rsv:0x40});await new Promise(r=>setTimeout(r,20));assert.deepEqual(c.closes,[1008]);await new Promise<void>(r=>c.socket.closed?r():c.socket.once("close",()=>r()));assert.equal(c.socket.closed,true);}finally{c.socket.destroy();await d.close();}});
test("§4 close 1008: hello later than configured window",async()=>{const {d,c}=await upgrade({helloTimeoutMs:15});try{await new Promise(r=>setTimeout(r,30));assert.deepEqual(c.closes,[1008]);}finally{c.socket.destroy();await d.close();}});
test("§4 hello_ack fields and capabilities",async()=>{const {d,c}=await upgrade();try{c.send(hello());const a=await c.next();assert.equal(a.protocol,1);assert.match(a.session_id,/^[0-9a-f-]{36}$/);assert.match(a.server_nonce,/^[A-Za-z0-9_-]{22}$/);assert.deepEqual(a.capabilities,["inspect_project"]);}finally{c.socket.destroy();await d.close();}});
test("protocol-v2 staging capability is explicit and V2-only bridges are gated before dispatch",async()=>{
	const v2=await readyV2({handlers:{stage_scene:async()=>{throw new Error("stage handler must stay hidden");}}});
	try{
		const q=request({method:"stage_scene"});v2.c.send(q);
		const rejected=await v2.c.next(m=>m.id===q.id&&m.type==="error");
		assert.equal(rejected.code,"CAPABILITY_NOT_NEGOTIATED");
		assert.deepEqual(v2.c.messages.filter(m=>m.type==="bridge_request"),[]);
	}finally{v2.c.socket.destroy();await v2.d.close();}
	const v3=await readyV3();
	v3.c.socket.destroy();await v3.d.close();
});
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

test("G011 streams out-of-order chunks positionally and returns bounded QA image content", async () => {
	const revision = "0".repeat(64);
	const bytes = QA_PNG;
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const written = Buffer.alloc(bytes.byteLength);
	let committed = false;
	const { d, c } = await readyV2({
		beginArtifactReservation: async (declaration) => {
			assert.deepEqual(declaration, { sha256, byteLength: bytes.byteLength });
			return {
				writeAt: async (position, chunk) => {
					written.set(chunk, position);
				},
				commit: async () => {
					committed = true;
					return { sha256, byteLength: bytes.byteLength, uri: `omb-artifact://sha256/${sha256}` };
				},
				abort: async () => {},
			};
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
		const split = 7;
		const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
		c.send({
			type: "bridge_artifact_begin",
			id: bridge.id,
			request_id: q.id,
			frame: 80,
			total_chunks: chunks.length,
			total_byte_length: bytes.byteLength,
			sha256,
		});
		for (const chunk_index of [1, 0]) {
			const chunk = chunks[chunk_index]!;
			c.send({
				type: "bridge_artifact_chunk",
				id: bridge.id,
				request_id: q.id,
				frame: 80,
				chunk_index,
				total_chunks: chunks.length,
				byte_offset: chunk_index === 0 ? 0 : split,
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
					image: { mime_type: "image/png", data_base64: bytes.toString("base64") },
				}],
			},
		});
		const response = await c.next((message) => message.type === "response" && message.id === q.id);
		assert.equal(committed, true);
		assert.deepEqual(written, bytes);
		assert.equal(response.result.frames[0].uri, `omb-artifact://sha256/${sha256}`);
		assert.equal(response.result.frames[0].image.data_base64, bytes.toString("base64"));
	} finally {
		c.socket.destroy();
		await d.close();
	}
});

type StreamReservationState = {
	aborted: boolean;
	abortCalls: number;
	committed: boolean;
	writes: Array<{ position: number; bytes: Buffer }>;
};

async function startRenderCase(frames: number[] = [80]) {
	const revision = "0".repeat(64);
	const reservations: StreamReservationState[] = [];
	const declarations: Array<{ sha256: string; byteLength: number }> = [];
	let firstWrite!: () => void;
	const firstWriteReceived = new Promise<void>((resolve) => {
		firstWrite = resolve;
	});
	const { d, c } = await readyV2({
		beginArtifactReservation: async (declaration) => {
			declarations.push(declaration);
			const state: StreamReservationState = { aborted: false, abortCalls: 0, committed: false, writes: [] };
			reservations.push(state);
			return {
				writeAt: async (position: number, chunk: Uint8Array) => {
					state.writes.push({ position, bytes: Buffer.from(chunk) });
					firstWrite();
				},
				commit: async () => {
					const payload = Buffer.alloc(declaration.byteLength);
					for (const write of state.writes) payload.set(write.bytes, write.position);
					if (createHash("sha256").update(payload).digest("hex") !== declaration.sha256) {
						throw new Error("ARTIFACT_DIGEST_MISMATCH: streamed bytes differ from the declaration");
					}
					state.committed = true;
					return {
						sha256: declaration.sha256,
						byteLength: declaration.byteLength,
						uri: `omb-artifact://sha256/${declaration.sha256}`,
					};
				},
				abort: async () => {
					state.abortCalls += 1;
					state.aborted = true;
				},
			};
		},
		handlers: {
			ok: async (_params, { renderQaFrames, signal }) => ({
				result: await renderQaFrames(
					{ schema_version: 1, revision_id: revision, frames },
					{ signal, reportProgress: () => {} },
				),
				resulting_revision_id: revision,
			}),
		},
	});
	const q = request({ expected_revision_id: revision });
	c.send(q);
	const bridge = await c.next((message) => message.type === "bridge_request");
	return { d, c, q, bridge, revision, reservations, declarations, firstWriteReceived };
}

function sendArtifactBegin(
	stream: Awaited<ReturnType<typeof startRenderCase>>,
	frameNumber: number,
	bytes: Uint8Array,
	totalChunks = 1,
	sha256 = createHash("sha256").update(bytes).digest("hex"),
) {
	stream.c.send({
		type: "bridge_artifact_begin",
		id: stream.bridge.id,
		request_id: stream.q.id,
		frame: frameNumber,
		total_chunks: totalChunks,
		total_byte_length: bytes.byteLength,
		sha256,
	});
}

function sendArtifactChunk(
	stream: Awaited<ReturnType<typeof startRenderCase>>,
	frameNumber: number,
	bytes: Uint8Array,
	overrides: Record<string, unknown> = {},
) {
	stream.c.send({
		type: "bridge_artifact_chunk",
		id: stream.bridge.id,
		request_id: stream.q.id,
		frame: frameNumber,
		chunk_index: 0,
		total_chunks: 1,
		byte_offset: 0,
		byte_length: bytes.byteLength,
		data_base64: Buffer.from(bytes).toString("base64"),
		...overrides,
	});
}

function sendRenderResult(
	stream: Awaited<ReturnType<typeof startRenderCase>>,
	frameNumber: number,
	bytes: Uint8Array,
	sha256 = createHash("sha256").update(bytes).digest("hex"),
) {
	stream.c.send({
		type: "bridge_result",
		id: stream.bridge.id,
		request_id: stream.q.id,
		result: {
			schema_version: 1,
			revision_id: stream.revision,
			profile_version: "omb-qa-png-v1",
			frames: [{
				frame: frameNumber,
				width: 640,
				height: 360,
				profile_version: "omb-qa-png-v1",
				byte_length: bytes.byteLength,
				sha256,
				image: { mime_type: "image/png", data_base64: Buffer.from(bytes).toString("base64") },
			}],
		},
	});
}

for (const [name, sendInvalid] of [
	["duplicate index", (stream: Awaited<ReturnType<typeof startRenderCase>>, bytes: Buffer) => {
		sendArtifactChunk(stream, 80, bytes);
		sendArtifactChunk(stream, 80, bytes);
	}],
	["changed total_chunks", (stream: Awaited<ReturnType<typeof startRenderCase>>, bytes: Buffer) => {
		sendArtifactChunk(stream, 80, bytes, { total_chunks: 2 });
	}],
	["malformed base64", (stream: Awaited<ReturnType<typeof startRenderCase>>, bytes: Buffer) => {
		sendArtifactChunk(stream, 80, bytes, { data_base64: "!!!!" });
	}],
	["changed decoded length", (stream: Awaited<ReturnType<typeof startRenderCase>>, bytes: Buffer) => {
		sendArtifactChunk(stream, 80, bytes, { byte_length: bytes.byteLength + 1 });
	}],
] as const) {
	test(`G011 aborts the reservation on ${name}`, async () => {
		const stream = await startRenderCase();
		const bytes = Buffer.from("chunk");
		try {
			sendArtifactBegin(stream, 80, bytes);
			sendInvalid(stream, bytes);
			const error = await stream.c.next((message) => message.type === "error" && message.id === stream.q.id);
			assert.equal(error.code, name === "malformed base64" ? "INVALID_BRIDGE_MESSAGE" : "INVALID_RENDER_QA_RESULT");
			assert.equal(stream.reservations[0]?.aborted, true);
		} finally {
			stream.c.socket.destroy();
			await stream.d.close();
		}
	});
}

test("G011 rejects and aborts an incomplete frame", async () => {
	const stream = await startRenderCase();
	const bytes = Buffer.from("incomplete");
	try {
		sendArtifactBegin(stream, 80, bytes, 2);
		sendArtifactChunk(stream, 80, bytes.subarray(0, 3), { total_chunks: 2 });
		sendRenderResult(stream, 80, bytes);
		const error = await stream.c.next((message) => message.type === "error" && message.id === stream.q.id);
		assert.equal(error.code, "INVALID_RENDER_QA_RESULT");
		assert.equal(stream.reservations[0]?.aborted, true);
	} finally {
		stream.c.socket.destroy();
		await stream.d.close();
	}
});

test("G011 rejects a declaration over 16 MiB before reserving it", async () => {
	const stream = await startRenderCase();
	try {
		stream.c.send({
			type: "bridge_artifact_begin",
			id: stream.bridge.id,
			request_id: stream.q.id,
			frame: 80,
			total_chunks: 32,
			total_byte_length: 16 * 1024 * 1024 + 1,
			sha256: "a".repeat(64),
		});
		const error = await stream.c.next((message) => message.type === "error" && message.id === stream.q.id);
		assert.equal(error.code, "RENDER_QA_FRAME_BYTES_EXCEEDED");
		assert.equal(stream.declarations.length, 0);
	} finally {
		stream.c.socket.destroy();
		await stream.d.close();
	}
});

test("G011 rejects declarations over 128 MiB as a batch and aborts prior reservations", async () => {
	const frames = Array.from({ length: 9 }, (_, index) => index + 1);
	const stream = await startRenderCase(frames);
	try {
		for (const frameNumber of frames) {
			stream.c.send({
				type: "bridge_artifact_begin",
				id: stream.bridge.id,
				request_id: stream.q.id,
				frame: frameNumber,
				total_chunks: 32,
				total_byte_length: 16 * 1024 * 1024,
				sha256: String(frameNumber).padStart(64, "0"),
			});
		}
		const error = await stream.c.next((message) => message.type === "error" && message.id === stream.q.id);
		assert.equal(error.code, "RENDER_QA_BATCH_BYTES_EXCEEDED");
		assert.equal(stream.reservations.length, 8);
		assert.equal(stream.reservations.every((reservation) => reservation.aborted), true);
	} finally {
		stream.c.socket.destroy();
		await stream.d.close();
	}
});

test("G011 rejects image content whose digest does not match metadata", async () => {
	const stream = await startRenderCase();
	const bytes = Buffer.from("authentic bytes");
	const tamperedSha = "f".repeat(64);
	try {
		sendArtifactBegin(stream, 80, bytes, 1, tamperedSha);
		sendArtifactChunk(stream, 80, bytes);
		sendRenderResult(stream, 80, bytes, tamperedSha);
		const error = await stream.c.next((message) => message.type === "error" && message.id === stream.q.id);
		assert.equal(error.code, "INVALID_RENDER_QA_RESULT");
		assert.equal(stream.reservations[0]?.aborted, true);
		assert.equal(stream.reservations[0]?.committed, false);
	} finally {
		stream.c.socket.destroy();
		await stream.d.close();
	}
});


test("G011 cancellation after the first streamed chunk aborts publication", async () => {
	const stream = await startRenderCase();
	const bytes = Buffer.from("cancelled stream");
	try {
		sendArtifactBegin(stream, 80, bytes);
		sendArtifactChunk(stream, 80, bytes);
		await stream.firstWriteReceived;
		stream.c.send({ type: "cancel", id: stream.q.id });
		assert.equal((await stream.c.next((message) => message.type === "cancel_ack")).status, "accepted");
		assert.equal((await stream.c.next((message) => message.type === "error" && message.id === stream.q.id)).code, "CANCELLED");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(stream.reservations[0]?.aborted, true);
		assert.equal(stream.reservations[0]?.committed, false);
	} finally {
		stream.c.socket.destroy();
		await stream.d.close();
	}
});

test("G011 cancelled bridge drains late artifact frames until its terminal acknowledgement", async () => {
	const stream = await startRenderCase();
	const bytes = Buffer.from("cancelled stream");
	try {
		sendArtifactBegin(stream, 80, bytes);
		sendArtifactChunk(stream, 80, bytes);
		await stream.firstWriteReceived;
		stream.c.send({ type: "cancel", id: stream.q.id });
		assert.equal((await stream.c.next((message) => message.type === "cancel_ack")).status, "accepted");
		assert.equal(
			(await stream.c.next((message) => message.type === "error" && message.id === stream.q.id)).code,
			"CANCELLED",
		);

		sendArtifactBegin(stream, 81, bytes);
		sendArtifactChunk(stream, 81, bytes);
		const nextRequest = request({ expected_revision_id: stream.revision });
		stream.c.send(nextRequest);
		const nextBridge = await stream.c.next(
			(message) => message.type === "bridge_request" && message.request_id === nextRequest.id,
		);
		stream.c.send({
			type: "bridge_progress",
			id: stream.bridge.id,
			request_id: stream.q.id,
			phase: 42,
		});
		stream.c.send({
			type: "bridge_error",
			id: nextBridge.id,
			request_id: nextRequest.id,
			code: "CURRENT_BRIDGE_FAILURE",
			message: "current bridge remained active",
			retryable: false,
		});
		const currentError = await stream.c.next(
			(message) => message.type === "error" && message.id === nextRequest.id,
		);
		assert.equal(currentError.code, "CURRENT_BRIDGE_FAILURE");
		stream.c.send({
			type: "bridge_cancel_ack",
			id: stream.bridge.id,
			request_id: stream.q.id,
			status: "accepted",
		});
		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.equal(stream.declarations.length, 1);
		assert.equal(stream.reservations.length, 1);
		assert.equal(stream.reservations[0]?.aborted, true);
		assert.equal(stream.reservations[0]?.abortCalls, 1);
		assert.equal(stream.reservations[0]?.committed, false);
	} finally {
		stream.c.socket.destroy();
		await stream.d.close();
	}
});

test("G011 disconnect after the first streamed chunk aborts publication", async () => {
	const stream = await startRenderCase();
	const bytes = Buffer.from("disconnected stream");
	sendArtifactBegin(stream, 80, bytes);
	sendArtifactChunk(stream, 80, bytes);
	await stream.firstWriteReceived;
	stream.c.socket.destroy();
	await stream.d.stopped;
	assert.equal(stream.reservations[0]?.aborted, true);
	assert.equal(stream.reservations[0]?.committed, false);
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
test("protocol-v2 keepalive pings survive more than three idle windows",async()=>{const {d,c}=await readyV2({idleTimeoutMs:30});try{for(let i=0;i<7;i++){await new Promise(r=>setTimeout(r,15));c.send({type:"ping",nonce:String(i)});await c.next(m=>m.type==="pong"&&m.nonce===String(i));}assert.equal(c.closes.length,0);assert.equal(c.socket.destroyed,false);}finally{c.socket.destroy();await d.close();}});
test("silent protocol-v2 bridge is closed after the idle window",async()=>{const {d,c}=await readyV2({idleTimeoutMs:20});try{await new Promise(r=>setTimeout(r,45));assert.deepEqual(c.closes,[1000]);assert.equal(c.socket.writableEnded,true);}finally{c.socket.destroy();await d.close();}});
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
