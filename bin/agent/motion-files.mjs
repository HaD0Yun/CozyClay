// Where a motion run writes its files: the run record (run.json, src/lowvis/pi/harness.mjs), the contact sheets and the clip
// (src/lowvis/pi/compile-tool.mjs). Nothing the Studio keeps is here: the writer's scene and spec go with the take into the scene
// document (src/lowvis/studio/install.js source), and the take holds the clip's frames.
// - A source checkout (a .git beside src/, as a clone or a worktree has): <root>/lowvis-out/pi/<name>/ and the clip at
//   <root>/public/lowvis/clips/pi/<name>.json, all kept, as the try-out and the measuring tools read them (both ignored by git).
// - An installed package (no .git: an npm cache or a global prefix, maybe read-only): nothing under the package. Each
//   run has a folder <config>/motion-runs/<name>/ (run.json, the sheets, clip.json), in the user's CozyClay config folder
//   where the Studio keeps its sessions (session-store.mjs). Nothing reads a run's files after its install
//   but the user, so only the newest KEEP runs stay: older ones are removed when a run starts.
// The page fetches a clip by name at /lowvis/clips/pi/<name>.json (src/lowvis/studio/clip-load.js): a dev server serves
// public/, and bin/cozyclay.mjs answers a name its build lacks with clipFile below.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../.."), KEEP = 20, NAME = /^[A-Za-z0-9_-]+$/;
const configDir = env => env.COZYCLAY_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cozyclay");

/**
 * The files of the motion run `name`: { outDir (run.json and the sheets), clipFile, kept: "all" | KEEP }.
 * root: the package folder (this one); env: where the config folder is. prune: remove the runs past the newest KEEP
 * (installed package only; a run counts by its folder's last change).
 */
export function runFiles(name, { env = process.env, root = ROOT, prune = false } = {}) {
	if (typeof name !== "string" || !NAME.test(name)) throw new Error(`a motion run's name is letters, digits, - and _ (got ${JSON.stringify(name)})`);
	if (existsSync(join(root, ".git"))) return { outDir: join(root, "lowvis-out/pi", name), clipFile: join(root, "public/lowvis/clips/pi", `${name}.json`), kept: "all" };
	const runs = join(configDir(env), "motion-runs"), outDir = join(runs, name);
	if (prune) {
		let old = [];
		try { old = readdirSync(runs).filter(n => n !== name && NAME.test(n)).map(n => ({ n, t: statSync(join(runs, n)).mtimeMs })); } catch { /* no runs yet */ }
		for (const { n } of old.sort((a, b) => b.t - a.t).slice(KEEP - 1)) rmSync(join(runs, n), { recursive: true, force: true });
	}
	return { outDir, clipFile: join(outDir, "clip.json"), kept: KEEP };
}
