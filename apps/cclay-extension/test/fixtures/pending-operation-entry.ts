// Child-process fixture for bridge-attach-keepalive.test.ts.
//
// The second half of the FAILURE B contract. `onDisconnect` deliberately does
// NOT reject a pending operation: it keeps the request_id so the replacement
// generation can supply the authoritative outcome. That makes reconnect and the
// operation deadline the only two things that can settle the caller's promise
// once the socket is gone. If both are unref'd, the loop drains with the caller
// still awaiting — which is what CI reported for the framed bridge tests.
//
// Here the add-on is stopped permanently, so only the deadline can settle the
// promise. `beforeExit` fires when the loop has no work left; if it fires while
// the operation is still pending, the contract is violated.
//
// Usage: node --import tsx pending-operation-entry.ts <projectDirectory>
import { BlenderBridge } from "../../src/bridge.ts";
import { FakeAddon, PROJECT_ID } from "../bridge-test-fixture.ts";

const projectDirectory = process.argv[2];
if (projectDirectory === undefined) throw new Error("usage: pending-operation-entry.ts <projectDirectory>");

const addon = new FakeAddon(projectDirectory);
await addon.start();
const bridge = new BlenderBridge(projectDirectory, { projectId: PROJECT_ID, operationTimeoutMs: 1_500 });
let settled = false;

process.on("beforeExit", () => {
	if (settled) return;
	console.log("LOOP_DRAINED");
	process.exit(3);
});

await bridge.start();
await bridge.waitForAttach();
const inspecting = bridge.inspectProject();
await addon.receive();
console.log("OPERATION_PENDING");
await addon.stop();
try {
	await inspecting;
	settled = true;
	console.log("OPERATION_SETTLED:resolved");
} catch (error) {
	settled = true;
	console.log(`OPERATION_SETTLED:${error instanceof Error ? error.message : String(error)}`);
} finally {
	await bridge.close();
}
