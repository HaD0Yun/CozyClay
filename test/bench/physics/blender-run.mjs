// One Blender run (docs/qa/physics-bench.md, PR 4): Blender 5.2 with the official Blender Lab MCP add-on in a window
// on the X display, driven by Claude Code (`claude -p`, only the Blender MCP server and Read), both as the `bench`
// user (the MCP server runs model-written Python with no guard). The harness builds the start .blend, saves the
// agent's live scene through the add-on's socket when the agent is done (the agent never exports), closes Blender
// and exports take.json from the saved file. Paths are the bench box's (docs/qa/physics-bench.md, Setup).
import { execFileSync, spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { basename, join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname, REPO = join(HERE, "../../..");
export const BLENDER = process.env.BLENDER ?? "/opt/blender-5.2.0-linux-x64/blender";
export const CLAUDE = process.env.BENCH_CLAUDE ?? "/opt/claude-code/bin/claude";
const MCP = process.env.BENCH_BLENDER_MCP ?? "/opt/blender-mcp-1.0.3/venv/bin/blender-mcp";
const RUN_USER = "bench", RUN_HOME = "/home/bench", XAUTHORITY = process.env.BENCH_XAUTHORITY ?? "/run/user/1000/gdm/Xauthority";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sudo = (...args) => execFileSync("sudo", args, { encoding: "utf8" });
const exited = child => new Promise(res => child.on("exit", (code, signal) => res(code ?? signal)));

/** Run Python in the live Blender through the MCP add-on's socket ({"type": "execute"} + NUL, add-on protocol 1.0.3).
 * The code must leave a dict in `result`. */
function bridge(port, code, timeoutMs = 120_000) {
	return new Promise((res, rej) => {
		const sock = connect(port, "127.0.0.1"), chunks = [];
		const timer = setTimeout(() => { sock.destroy(); rej(new Error(`bridge ${port} timed out`)); }, timeoutMs);
		sock.on("connect", () => sock.write(`${JSON.stringify({ type: "execute", code, strict_json: false })}\0`));
		sock.on("data", d => {
			chunks.push(d);
			const all = Buffer.concat(chunks), end = all.indexOf(0);
			if (end < 0) return;
			clearTimeout(timer);
			sock.end();
			try { res(JSON.parse(all.subarray(0, end).toString("utf8"))); } catch (e) { rej(e); }
		});
		sock.on("error", e => { clearTimeout(timer); rej(e); });
	});
}

const startBridge = (port, marker) => [
	"import bpy, addon_utils", `# ${marker}`, "def go():",
	"    addon_utils.enable('bl_ext.user_default.mcp', default_set=True)",
	`    bpy.context.preferences.addons['bl_ext.user_default.mcp'].preferences.port = ${port}`,
	"    print('BRIDGE', bpy.ops.blmcp.server_start())",
	"bpy.app.timers.register(go, first_interval=1.0, persistent=True)",
].join("\n");

/** One run; resolves with what the harness measured. `dir` is the run directory (owned by the harness user). */
export async function runBlender({ set, dir, lane, request, model, effort, timeoutMin }) {
	const id = basename(dir), bd = `${RUN_HOME}/physics-runs/${id}`, port = 19900 + lane, xdg = `/tmp/bench-xdg-${lane}`, marker = `BENCHRUN_${id}`;
	const setPath = join(HERE, "sets", `${set.id}.json`), out = { port, benchDir: bd };
	execFileSync(BLENDER, ["-b", "--factory-startup", "--python", join(HERE, "blender/build_scene.py"), "--", setPath, join(REPO, "public/models/y-bot-tpose.fbx"), join(dir, "start.blend")], { stdio: "ignore", timeout: 300_000 });
	writeFileSync(join(dir, "request.txt"), request);
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { blender: { command: MCP, env: { BLENDER_MCP_PORT: String(port) } } } }));
	sudo("-u", RUN_USER, "mkdir", "-p", "-m", "700", bd, xdg);
	for (const f of ["start.blend", "request.txt", "mcp.json"]) sudo("install", "-o", RUN_USER, "-g", RUN_USER, "-m", "600", join(dir, f), `${bd}/${f}`);
	execFileSync("xhost", [`+SI:localuser:${RUN_USER}`], { env: { ...process.env, DISPLAY: ":0", XAUTHORITY }, stdio: "ignore" });
	const blog = openSync(join(dir, "blender.log"), "a");
	const blender = spawn("sudo", ["-u", RUN_USER, "-H", "env", "DISPLAY=:0", `XDG_RUNTIME_DIR=${xdg}`, BLENDER, "--online-mode", "--window-geometry", String(lane * 660), "0", "1280", "800",
		`${bd}/start.blend`, "--python-expr", startBridge(port, marker)], { stdio: ["ignore", blog, blog], detached: true });
	const stop = async () => { try { sudo("pkill", "-TERM", "-f", marker); } catch { /* gone */ } await sleep(3000); try { sudo("pkill", "-KILL", "-f", marker); } catch { /* gone */ } };
	try {
		let ready = false;
		for (const t0 = Date.now(); !ready && Date.now() - t0 < 120_000; await sleep(1000)) ready = (await bridge(port, "result = {'ok': 1}", 5000).catch(() => null))?.status === "ok";
		if (!ready) throw new Error(`the Blender bridge on ${port} never answered (see blender.log)`);
		const limit = Number(timeoutMin) * 60;
		const sh = [`set -a; . ${RUN_HOME}/.cliproxy.env; set +a`,
			`export CLAUDE_CONFIG_DIR=${bd}/claude-config DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
			`cd ${bd}`,
			`exec timeout -s TERM -k 30 ${limit} ${CLAUDE} -p --model ${model} --effort ${effort} --mcp-config ${bd}/mcp.json --strict-mcp-config --tools Read --allowedTools 'mcp__blender__*' Read --permission-mode bypassPermissions --setting-sources '' --output-format stream-json --verbose < ${bd}/request.txt`].join("; ");
		out.sentAt = Date.now();
		const agent = spawn("sudo", ["-u", RUN_USER, "-H", "bash", "-c", sh], { stdio: ["ignore", openSync(join(dir, "claude.jsonl"), "w"), openSync(join(dir, "claude.err"), "w")] });
		out.exitCode = await exited(agent);
		out.endAt = Date.now();
		out.timedOut = out.exitCode === 124 || out.endAt - out.sentAt >= limit * 1000;
		const saved = await bridge(port, `import bpy\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(`${bd}/result.blend`)}, copy=True, compress=True)\nresult = {"saved": True}`, 180_000).catch(e => ({ status: "error", message: e.message }));
		out.saved = saved.status === "ok";
		if (!out.saved) out.saveError = String(saved.message ?? "").slice(0, 300);
	} catch (e) {
		out.error = String(e.message).slice(0, 600);
	} finally {
		await stop();
		await Promise.race([exited(blender), sleep(5000)]);
	}
	if (out.saved) {
		sudo("cp", `${bd}/result.blend`, join(dir, "result.blend"));
		sudo("chown", `${process.getuid()}:${process.getgid()}`, join(dir, "result.blend"));
		try {
			execFileSync(BLENDER, ["-b", join(dir, "result.blend"), "--python", join(HERE, "blender/export_take.py"), "--", setPath, join(dir, "take.json"), JSON.stringify({ run: id })], { stdio: "ignore", timeout: 600_000 });
		} catch (e) { out.exportError = String(e.message).slice(0, 300); }
	}
	return out;
}
