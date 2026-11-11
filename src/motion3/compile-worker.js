// The motion compile worker: runs compile jobs (compile-job.js) off the editor's main thread, one at a time
// in arrival order, and answers each { id } with { id, value } (typed arrays transferred) or { id, error }.
// On the main thread the compiler runs about 4x slower than here (measured: 6.2 s against 1.5 s for a
// 240-frame carry) and blocks the viewport and the agent panel for the whole compile.
// The collision body fits are fetched when the worker starts and the first job waits for them, so a compile here
// (an adapted rig's refit of the X Bot's fit included: rigs/index.js) never reads one by synchronous XHR.
import { jobServer } from "./compile-job.js";
import { preloadBodies } from "./body.js";

const serve = jobServer((message, transfer) => self.postMessage(message, transfer), preloadBodies());
self.onmessage = ({ data }) => serve(data);
