import type { Clock } from "./token.ts";

export type RequestPhase = "running" | "completing" | "cancelling" | "terminal";
export type TerminalCause = "CANCELLED" | "TIMEOUT" | "SHUTDOWN" | "DISCONNECT";
export type ActiveRequest = { id:string; phase:RequestPhase; controller:AbortController; cause?:TerminalCause; timer?:ReturnType<typeof setTimeout> };

export class SessionState {
	private active?: ActiveRequest; private tokens=4; private refilledAt:number;
	private readonly clock: Clock;
	private readonly wake: (request: ActiveRequest) => void;
	constructor(clock:Clock, wake:(request:ActiveRequest)=>void) { this.clock=clock;this.wake=wake;this.refilledAt=clock.now(); }
	consumeToken(): boolean { const now=this.clock.now();this.tokens=Math.min(4,this.tokens+(now-this.refilledAt)/1000);this.refilledAt=now;if(this.tokens<1)return false;this.tokens-=1;return true; }
	get current():ActiveRequest|undefined{return this.active;}
	begin(id:string, deadlineMs:number): "ok"|"busy" { if(this.active && this.active.phase!=="terminal")return "busy";const r:ActiveRequest={id,phase:"running",controller:new AbortController()};this.active=r;r.timer=setTimeout(()=>{if(this.cas(r,"running","cancelling")){r.cause="TIMEOUT";r.controller.abort();this.wake(r);}},deadlineMs);return "ok"; }
	complete(r:ActiveRequest):boolean{return this.cas(r,"running","completing");}
	cancel(id:string,cause:TerminalCause="CANCELLED"):"accepted"|"already_terminal"|"unknown" { const r=this.active;if(!r||r.id!==id)return "unknown";if(this.cas(r,"running","cancelling")){r.cause=cause;r.controller.abort();this.wake(r);return "accepted";}return "already_terminal"; }
	terminal(r:ActiveRequest):boolean { if(r!==this.active || r.phase==="terminal")return false;clearTimeout(r.timer);r.phase="terminal";return true; }
	private cas(r:ActiveRequest,from:RequestPhase,to:RequestPhase):boolean { if(this.active!==r||r.phase!==from)return false;r.phase=to;return true; }
}
