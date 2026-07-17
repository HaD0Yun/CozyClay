import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { start } from "../src/daemon.ts";
import { BearerToken } from "../src/token.ts";

test("bearer token is 32-byte base64url, expires, and is single use",()=>{
	let now=0;const token=new BearerToken({now:()=>now},Buffer.alloc(32,7));
	assert.match(token.value,/^[A-Za-z0-9_-]{43}$/);token.startExpiry();
	assert.equal(token.consume("x".repeat(43)),false);assert.equal(token.consume(token.value),true);assert.equal(token.consume(token.value),false);
	const expired=new BearerToken({now:()=>now});expired.startExpiry();now=10_000;assert.equal(expired.consume(expired.value),false);
});

test("daemon binds loopback, emits a valid startup record, and rejects bad auth",async()=>{
	const lines:string[]=[];const daemon=await start({port:0,stdout:line=>lines.push(line),handlers:{}});
	try {
		assert.equal(lines.length,1);assert.equal(daemon.startup.port,daemon.port);assert.equal(daemon.startup.pid,process.pid);
		const response=await new Promise<string>((resolve,reject)=>{const socket=net.connect(daemon.port,"127.0.0.1",()=>socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${daemon.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nAuthorization: Bearer invalid\r\n\r\n`));let value="";socket.on("data",b=>value+=b);socket.on("end",()=>resolve(value));socket.on("error",reject);});
		assert.match(response,/^HTTP\/1\.1 403 Forbidden/);
	} finally { await daemon.close(); }
});
