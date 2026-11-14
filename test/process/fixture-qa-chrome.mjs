#!/usr/bin/env node
import { createServer } from "node:http";

const args = process.argv.slice(2);
console.log(JSON.stringify({
	fixture: "qa-chrome",
	args,
	desktopBus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
	runtimeDir: process.env.XDG_RUNTIME_DIR ?? null,
	pid: process.pid,
}));
console.error("fixture browser stderr");
if (process.env.QA_CHROME_FIXTURE === "exit") process.exit(17);
const port = Number(args.find(arg => arg.startsWith("--remote-debugging-port=")).split("=")[1]);
const server = createServer(() => {});
server.listen(port, "127.0.0.1", () => {
	if (process.env.QA_CHROME_FIXTURE === "stuck-cdp")
		console.error(`DevTools listening on ws://127.0.0.1:${port}/devtools/browser/fixture`);
});
