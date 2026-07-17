import http from "node:http";
import { randomUUID } from "node:crypto";
import { parseClientMessage, parseHello, parseStartupRecord, PROTOCOL_VERSION, type Request } from "../../../packages/blender-protocol/src/messages.ts";
import { BearerToken, randomNonce, systemClock, type Clock } from "./token.ts";
import { acceptUpgrade, type WebSocketConnection } from "./ws-server.ts";
import { SessionState, type ActiveRequest } from "./session-state.ts";

export type HandlerResult={ result:unknown; resulting_revision_id:string };
export type Handler=(params:Record<string,unknown>, context:{signal:AbortSignal;request:Request;reportProgress:(phase:string,completed:number,total:number)=>void})=>Promise<HandlerResult>;
export type DaemonOptions={port:number;clock?:Clock;handlers:Record<string,Handler>;stdout?:(line:string)=>void;stderr?:(line:string)=>void;helloTimeoutMs?:number;idleTimeoutMs?:number};
export type Daemon={port:number;startup:ReturnType<typeof parseStartupRecord>;stopped:Promise<void>;close():Promise<void>};

export async function start(options:DaemonOptions):Promise<Daemon>{
	const clock=options.clock??systemClock, token=new BearerToken(clock), launchId=randomUUID(), nonces=new Set<string>();let accepted=false, connection:WebSocketConnection|undefined, draining=false, idle:ReturnType<typeof setTimeout>|undefined;
	let resolveStopped!:()=>void;const stopped=new Promise<void>(resolve=>{resolveStopped=resolve;});
	const server=http.createServer((_q,r)=>{r.writeHead(403);r.end();});
	const closeServer=()=>new Promise<void>((resolve,reject)=>{if(!server.listening)return resolve();server.close(error=>error?reject(error):resolve());});
	server.on("upgrade",(req,socket)=>{const ws=acceptUpgrade(req,socket,token,addressPort(),accepted);if(!ws)return;accepted=true;connection=ws;run(ws);});
	await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(options.port,"127.0.0.1",resolve);});
	const addressPort=()=>{const a=server.address();if(!a||typeof a==="string")throw new Error("not listening");return a.port;};
	const startup=parseStartupRecord({type:"omb_daemon_ready",protocol:PROTOCOL_VERSION,port:addressPort(),pid:process.pid,launch_id:launchId,bearer_token:token.value,expires_in_ms:10000});token.startExpiry();(options.stdout??(line=>process.stdout.write(line+"\n")))(JSON.stringify(startup));
	function run(ws:WebSocketConnection){let hello=false;const helloTimer=setTimeout(()=>{if(!hello)ws.close(1008,"hello timeout");},options.helloTimeoutMs??3000);const state=new SessionState(clock,r=>void finishCancellation(r));
		const resetIdle=()=>{clearTimeout(idle);idle=setTimeout(()=>ws.close(1000,"idle"),options.idleTimeoutMs??60000);};resetIdle();
		ws.on("text",(text:string)=>{resetIdle();void message(text);});ws.on("disconnect",()=>{clearTimeout(helloTimer);clearTimeout(idle);const r=state.current;if(r)state.cancel(r.id,"DISCONNECT");});
		async function message(text:string){let raw:any;try{raw=JSON.parse(text);}catch{state.consumeToken();return;}if(!hello){try{const h=parseHello(raw);if(nonces.has(h.client_nonce))return ws.close(1008,"nonce reused");nonces.add(h.client_nonce);hello=true;clearTimeout(helloTimer);ws.sendText({type:"hello_ack",protocol:1,daemon_version:"0.1.0",launch_id:launchId,session_id:randomUUID(),server_nonce:randomNonce(),capabilities:["inspect_project"]});return;}catch{return ws.close(1008,"invalid hello");}}
			if(raw?.type==="hello"){if(nonces.has(raw.client_nonce))return ws.close(1008,"nonce reused");return ws.close(1008,"hello already completed");}if(raw?.type==="ping"){ws.sendText({type:"pong",nonce:raw.nonce});return;}if(raw?.type==="cancel"){const status=state.cancel(raw.id);ws.sendText({type:"cancel_ack",id:raw.id,status});return;}if(raw?.type==="shutdown"){await shutdown();return;}if(raw?.type!=="request"){try{parseClientMessage(raw);}catch{state.consumeToken();}return;}
			if(!state.consumeToken()){return ws.sendText(error(raw.id,"RATE_LIMITED","rate limit exceeded",true));}
			if(!Number.isInteger(raw.deadline_ms)||raw.deadline_ms<100||raw.deadline_ms>30000)return ws.sendText(error(raw.id,"INVALID_DEADLINE","deadline_ms must be 100..30000",false));
			let request:Request;try{request=parseClientMessage(raw) as Request;}catch{return ws.sendText(error(raw.id,"INVALID_REQUEST","invalid request",false));}
			if(state.begin(request.id,request.deadline_ms)==="busy")return ws.sendText(error(request.id,"BUSY","one request is already active",true));const r=state.current!;const handler=options.handlers[request.method];if(!handler){state.complete(r);state.terminal(r);return ws.sendText(error(request.id,"METHOD_NOT_ALLOWED","method is not allowed",false));}
			try{const out=await handler(request.params,{signal:r.controller.signal,request,reportProgress:(phase,completed,total)=>{if(r.phase==="running")ws.sendText({type:"progress",id:r.id,phase,completed,total});}});if(state.complete(r)){state.terminal(r);ws.sendText({type:"response",id:r.id,...out});}}catch(e){if(r.phase==="running"&&state.complete(r)){state.terminal(r);ws.sendText(error(r.id,"HANDLER_ERROR",e instanceof Error?e.message:"handler failed",false));}}
		}
		async function finishCancellation(r:ActiveRequest){await Promise.resolve();if(state.terminal(r)&&!ws.socket.destroyed)ws.sendText(error(r.id,r.cause==="TIMEOUT"?"TIMEOUT":"CANCELLED",r.cause==="TIMEOUT"?"deadline expired":"request cancelled",false));}
		async function shutdown(){if(draining)return;draining=true;server.close();const r=state.current;if(r)state.cancel(r.id,"SHUTDOWN");await Promise.resolve();ws.sendText({type:"shutdown_ack"});ws.close(1000);clearTimeout(idle);token.zero();await closeServer().catch(()=>{});resolveStopped();}
	}
	return{port:addressPort(),startup,stopped,close:async()=>{draining=true;clearTimeout(idle);connection?.close(1000);token.zero();await closeServer();resolveStopped();}};
}
const error=(id:string,code:string,message:string,retryable:boolean)=>({type:"error",id,code,message,retryable});
