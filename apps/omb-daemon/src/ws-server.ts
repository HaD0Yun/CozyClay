import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { EventEmitter } from "node:events";
import { BearerToken } from "./token.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX = 1024 * 1024;

export class WebSocketConnection extends EventEmitter {
	private buffer = Buffer.alloc(0); private fragments: Buffer[] = []; private fragmentBytes = 0;
	private fragmentOpcode = 0; private closed = false;
	readonly socket: Duplex;
	constructor(socket: Duplex) { super();this.socket=socket; socket.on("data", b => this.read(b)); socket.on("close", () => this.emit("disconnect")); socket.on("error", () => { /* close event drives cleanup */ }); }
	sendText(value: unknown): void { this.frame(1, Buffer.from(JSON.stringify(value))); }
	pong(payload: Buffer): void { this.frame(10, payload); }
	close(code = 1000, reason = ""): void { if (this.closed) return; this.closed = true; const p = Buffer.alloc(2 + Buffer.byteLength(reason)); p.writeUInt16BE(code); p.write(reason, 2); this.frame(8, p); this.socket.end(); }
	private frame(opcode: number, payload: Buffer): void { if (this.socket.destroyed || !this.socket.writable) return; let h: Buffer; if (payload.length < 126) h = Buffer.from([0x80 | opcode, payload.length]); else if (payload.length <= 65535) { h=Buffer.alloc(4); h[0]=0x80|opcode; h[1]=126; h.writeUInt16BE(payload.length,2); } else { h=Buffer.alloc(10); h[0]=0x80|opcode; h[1]=127; h.writeBigUInt64BE(BigInt(payload.length),2); } this.socket.write(Buffer.concat([h,payload]),()=>{}); }
	private read(chunk: Buffer): void { this.buffer=Buffer.concat([this.buffer,chunk]); while (this.buffer.length >= 2) { const a=this.buffer[0]!, b=this.buffer[1]!; const fin=!!(a&128), opcode=a&15, masked=!!(b&128); if (!masked) return this.close(1008,"client frames must be masked"); let len=b&127, off=2; if(len===126){if(this.buffer.length<4)return;len=this.buffer.readUInt16BE(2);off=4;} else if(len===127){if(this.buffer.length<10)return;const n=this.buffer.readBigUInt64BE(2);if(n>BigInt(MAX))return this.close(1009);len=Number(n);off=10;} if(this.buffer.length<off+4+len)return; const mask=this.buffer.subarray(off,off+4);off+=4;const data=Buffer.from(this.buffer.subarray(off,off+len));this.buffer=this.buffer.subarray(off+len);for(let i=0;i<data.length;i++)data[i]^=mask[i&3]!; if(opcode>=8 && (!fin || len>125)) return this.close(1008); if(opcode===8){const code=data.length>=2?data.readUInt16BE(0):1000;this.close(code);return;} if(opcode===9){this.pong(data);continue;} if(opcode===10){this.emit("pong",data);continue;} if(opcode===2)return this.close(1008,"binary unsupported"); if(opcode===1){if(this.fragmentOpcode)return this.close(1008); if(fin){if(len>MAX)return this.close(1009);this.emit("text",data.toString("utf8"));}else{this.fragmentOpcode=1;this.fragments=[data];this.fragmentBytes=len;}} else if(opcode===0){if(!this.fragmentOpcode)return this.close(1008);this.fragmentBytes+=len;if(this.fragmentBytes>MAX)return this.close(1009);this.fragments.push(data);if(fin){const msg=Buffer.concat(this.fragments).toString("utf8");this.fragments=[];this.fragmentOpcode=0;this.fragmentBytes=0;this.emit("text",msg);}} else return this.close(1008); } }
}

export function acceptUpgrade(req: IncomingMessage, socket: Duplex, token: BearerToken, port: number, alreadyAccepted: boolean): WebSocketConnection | undefined {
	const reject=()=>{socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");return undefined;};
	if(alreadyAccepted || req.headers.host!==`127.0.0.1:${port}` || (req.headers.origin!==undefined && req.headers.origin!==`http://127.0.0.1:${port}`)) return reject();
	const key=req.headers["sec-websocket-key"], auth=req.headers.authorization;
	if(req.headers.upgrade?.toLowerCase()!== "websocket" || req.headers["sec-websocket-version"]!== "13" || typeof key!== "string" || Buffer.from(key,"base64").length!==16) return reject();
	if(typeof auth!=="string" || !auth.startsWith("Bearer ") || !token.consume(auth.slice(7))) return reject();
	const accept=createHash("sha1").update(key+GUID).digest("base64"); socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`); return new WebSocketConnection(socket);
}
