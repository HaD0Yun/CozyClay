// Child-process fixture for bridge-attach-keepalive.test.ts.
//
// The counterpart of attach-waiter-entry.ts: a started bridge with NO attach
// waiter must not hold the process open. Keeping the reconnect timer ref'd
// unconditionally would turn every extension host into a process that can never
// exit, so the keep-alive must be scoped to outstanding waiters only.
//
// Usage: node --import tsx idle-bridge-entry.ts <projectDirectory>
import { BlenderBridge } from "../../src/bridge.ts";

const projectDirectory = process.argv[2];
if (projectDirectory === undefined) throw new Error("usage: idle-bridge-entry.ts <projectDirectory>");

const bridge = new BlenderBridge(projectDirectory);
await bridge.start();
console.log("IDLE_STARTED");
