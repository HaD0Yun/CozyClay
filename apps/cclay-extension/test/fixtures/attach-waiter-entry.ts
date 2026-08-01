// Child-process fixture for bridge-attach-keepalive.test.ts.
//
// Nothing else keeps this process alive: no server, no FakeAddon, no ref'd
// timer. The only outstanding work is the bridge and the promise returned by
// `waitForAttach()`. Discovery is absent, which is the ordinary "Blender has not
// opened yet" state, so the correct behaviour is to keep waiting.
//
// `beforeExit` fires when the loop has no work left. If it fires while an attach
// waiter is still parked, the bridge has told Node it has nothing to do while a
// caller is still awaiting it — the contract violation this fixture exists to
// catch. The parent expects this process to stay alive until it is killed.
//
// Usage: node --import tsx attach-waiter-entry.ts <projectDirectory>
import { BlenderBridge } from "../../src/bridge.ts";

const projectDirectory = process.argv[2];
if (projectDirectory === undefined) throw new Error("usage: attach-waiter-entry.ts <projectDirectory>");

const bridge = new BlenderBridge(projectDirectory);
let settled = false;

process.on("beforeExit", () => {
	if (settled) return;
	console.log("LOOP_DRAINED");
	process.exit(3);
});

await bridge.start();
console.log("WAITER_PARKED");
try {
	await bridge.waitForAttach();
	settled = true;
	console.log("ATTACH_SETTLED:resolved");
} catch (error) {
	settled = true;
	console.log(`ATTACH_SETTLED:${error instanceof Error ? error.message : String(error)}`);
}
