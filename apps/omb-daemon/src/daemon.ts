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
	const clock=options.clock??systemClock, token=new BearerToken(clock), launchId=randomUUID(), nonces=new Set<string>(), seenRequestIds=new Set<string>();let accepted=false, connection:WebSocketConnection|undefined, draining=false, idle:ReturnType<typeof setTimeout>|undefined;
	let resolveStopped!:()=>void;const stopped=new Promise<void>(resolve=>{resolveStopped=resolve;});
	const server=http.createServer((_q,r)=>{r.writeHead(403);r.end();});
	const closeServer=()=>new Promise<void>((resolve,reject)=>{if(!server.listening)return resolve();server.close(error=>error?reject(error):resolve());});
	server.on("upgrade",(req,socket)=>{const ws=acceptUpgrade(req,socket,token,addressPort(),accepted);if(!ws)return;accepted=true;connection=ws;run(ws);});
	await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(options.port,"127.0.0.1",resolve);});
	const addressPort=()=>{const a=server.address();if(!a||typeof a==="string")throw new Error("not listening");return a.port;};
	const startup=parseStartupRecord({type:"omb_daemon_ready",protocol:PROTOCOL_VERSION,port:addressPort(),pid:process.pid,launch_id:launchId,bearer_token:token.value,expires_in_ms:10000});token.startExpiry();(options.stdout??(line=>process.stdout.write(line+"\n")))(JSON.stringify(startup));
	function run(ws:WebSocketConnection){let hello=false, activeHandler:Promise<void>|undefined, drainPromise:Promise<void>|undefined;const helloTimer=setTimeout(()=>{if(!hello)ws.close(1008,"hello timeout");},options.helloTimeoutMs??3000);const state=new SessionState(clock,r=>void finishCancellation(r));
		const resetIdle=()=>{clearTimeout(idle);idle=setTimeout(()=>ws.close(1000,"idle"),options.idleTimeoutMs??60000);};resetIdle();
		ws.on("text",(text:string)=>{resetIdle();void message(text);});ws.on("disconnect",()=>{clearTimeout(helloTimer);clearTimeout(idle);void drain("DISCONNECT",false);});
		async function message(text:string){let raw:any;try{raw=JSON.parse(text);}catch{state.consumeToken();return;}if(!hello){try{const h=parseHello(raw);if(nonces.has(h.client_nonce))return ws.close(1008,"nonce reused");nonces.add(h.client_nonce);hello=true;clearTimeout(helloTimer);ws.sendText({type:"hello_ack",protocol:1,daemon_version:"0.1.0",launch_id:launchId,session_id:randomUUID(),server_nonce:randomNonce(),capabilities:["inspect_project"]});return;}catch{return ws.close(1008,"invalid hello");}}
			if(raw?.type==="hello"){if(nonces.has(raw.client_nonce))return ws.close(1008,"nonce reused");return ws.close(1008,"hello already completed");}
			if(raw?.type==="request"){if(!state.consumeToken())return ws.sendText(error(raw.id,"RATE_LIMITED","rate limit exceeded",true));if(!Number.isInteger(raw.deadline_ms)||raw.deadline_ms<100||raw.deadline_ms>30000)return ws.sendText(error(raw.id,"INVALID_DEADLINE","deadline_ms must be 100..30000",false));let request:Request;try{request=parseClientMessage(raw) as Request;}catch{return ws.sendText(error(raw.id,"INVALID_REQUEST","invalid request",false));}return execute(request);}
			let parsed:ReturnType<typeof parseClientMessage>;try{parsed=parseClientMessage(raw);}catch{state.consumeToken();return;}
			if(parsed.type==="ping"){ws.sendText({type:"pong",nonce:parsed.nonce});return;}if(parsed.type==="cancel"){const status=state.cancel(parsed.id);ws.sendText({type:"cancel_ack",id:parsed.id,status});return;}if(parsed.type==="shutdown"){await drain("SHUTDOWN",true);return;}
		}
		async function execute(request:Request){
			if(seenRequestIds.has(request.id))return ws.sendText(error(request.id,"INVALID_REQUEST","request id has already been used",false));seenRequestIds.add(request.id);
			if(state.begin(request.id,request.deadline_ms)==="busy")return ws.sendText(error(request.id,"BUSY","one request is already active",true));const r=state.current!;const handler=options.handlers[request.method];if(!handler){state.complete(r);state.terminal(r);return ws.sendText(error(request.id,"METHOD_NOT_ALLOWED","method is not allowed",false));}
			const task=(async()=>{try{const out=await handler(request.params,{signal:r.controller.signal,request,reportProgress:(phase,completed,total)=>{if(r.phase==="running")ws.sendText({type:"progress",id:r.id,phase,completed,total});}});if(state.complete(r)){state.terminal(r);ws.sendText({type:"response",id:r.id,...out});}}catch(e){if(r.phase==="running"&&state.complete(r)){state.terminal(r);const m=e instanceof Error?e.message:"handler failed";const parsed=/^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/.exec(m);ws.sendText(error(r.id,parsed?parsed[1]:"HANDLER_ERROR",parsed?parsed[2]:m,false));}}})();activeHandler=task;await task;if(activeHandler===task)activeHandler=undefined;
		}
		async function finishCancellation(r:ActiveRequest){await Promise.resolve();if(state.terminal(r)&&!ws.socket.destroyed)ws.sendText(error(r.id,r.cause==="TIMEOUT"?"TIMEOUT":"CANCELLED",r.cause==="TIMEOUT"?"deadline expired":"request cancelled",false));}
		function drain(cause:"SHUTDOWN"|"DISCONNECT",acknowledge:boolean):Promise<void>{if(drainPromise)return drainPromise;draining=true;server.close();const r=state.current,cancelled=r?state.cancel(r.id,cause)==="accepted":false;drainPromise=(async()=>{if(cancelled&&activeHandler){let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([activeHandler,new Promise<void>(resolve=>{timer=setTimeout(resolve,5000);})]);clearTimeout(timer);}if(acknowledge&&!ws.socket.destroyed)ws.sendText({type:"shutdown_ack"});if(!ws.socket.destroyed)ws.close(1000);clearTimeout(idle);token.zero();try{await closeServer();}catch(e){(options.stderr??(line=>process.stderr.write(line+"\n")))(`daemon cleanup failed: ${e instanceof Error?e.message:String(e)}`);}resolveStopped();})();return drainPromise;}
	}
	return{port:addressPort(),startup,stopped,close:async()=>{draining=true;clearTimeout(idle);connection?.close(1000);token.zero();await closeServer();resolveStopped();}};
}
const error=(id:string,code:string,message:string,retryable:boolean)=>({type:"error",id,code,message,retryable});
