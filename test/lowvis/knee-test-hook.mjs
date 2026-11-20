// By hand, not in the suite: `KNEE_BASE=<sha> KNEE_HOOK_OUT=<file> node --import ./test/lowvis/knee-test-hook.mjs <test>`
// runs a test with every solve() call also run through the base commit's solve.js on a copy of the same input; the
// test goes on with this tree's result. At exit one JSON line goes to KNEE_HOOK_OUT: calls, calls whose output differs
// to the last bit, and why each differing call differs (whether every reading of knee-sweep.mjs has the base's knee on
// the wrong side, whether the base's pole has under 0.25 along the knee's side, and whether anything but the legs
// differs).
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../../", import.meta.url), es = new URL("src/lowvis/engine-simple/", root);
const tmp = mkdtempSync(join(tmpdir(), "knee-hook-"));
const baseSrc = execFileSync("git", ["show", `${process.env.KNEE_BASE}:src/lowvis/engine-simple/solve.js`], { cwd: root.pathname, encoding: "utf8" })
	.replace('"../rig17.js"', JSON.stringify(new URL("../rig17.js", es).href)).replace('"./math.js"', JSON.stringify(new URL("math.js", es).href));
writeFileSync(join(tmp, "solve-base.js"), baseSrc);
globalThis.__knee = { test: process.argv[1], calls: 0, differ: 0, why: {} };
writeFileSync(join(tmp, "solve-wrap.mjs"), `
import * as real from ${JSON.stringify(new URL("solve.js?real", es).href)};
import { solve as base } from ${JSON.stringify(pathToFileURL(join(tmp, "solve-base.js")).href)};
import { LIMBS, limbSide, poleAlongSide } from ${JSON.stringify(new URL("test/lowvis/knee-sweep.mjs", root).href)};
export const { SIDES, ARM_LEN, LEG_LEN, TOE, SOLE, MAX_STEP, ASSIST_BEND, arc } = real;
const flat = r => [...r.pos.flat(), ...r.quat.flat(), r.assist.bend, r.assist.drop, ...r.slow, ...r.late, ...r.lift];
export function solve(B, U = {}) {
	const b = base(structuredClone(B), structuredClone(U)), r = real.solve(B, U), S = globalThis.__knee, x = flat(b), y = flat(r);
	S.calls++;
	if (x.length === y.length && x.every((v, i) => Object.is(v, y[i]))) return r;
	S.differ++;
	const knees = LIMBS.filter(l => l.leg), wrong = knees.some(L => !(limbSide(b.pos, b.quat, L).twist <= 90));
	const legsOnly = [...Array(11).keys()].every(j => [0, 1, 2].every(k => Object.is(b.pos[j][k], r.pos[j][k])) && [0, 1, 2, 3].every(k => Object.is(b.quat[j][k], r.quat[j][k])));
	const key = (wrong ? "base knee on the wrong side by every reading, or unread" : knees.some(L => poleAlongSide(b, L) < 0.25) ? "the base pole's part along the knee's side under 0.25" : "OTHER") + (legsOnly ? "" : ", NOT legs only");
	S.why[key] = (S.why[key] ?? 0) + 1;
	return r;
}`);
const target = new URL("solve.js", es).href, wrap = pathToFileURL(join(tmp, "solve-wrap.mjs")).href;
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(spec, ctx, next) {
	const r = await next(spec, ctx);
	return r.url === ${JSON.stringify(target)} && ctx.parentURL !== ${JSON.stringify(wrap)} ? { ...r, url: ${JSON.stringify(wrap)} } : r;
}`)}`);
process.on("exit", () => process.env.KNEE_HOOK_OUT && appendFileSync(process.env.KNEE_HOOK_OUT, `${JSON.stringify(globalThis.__knee)}\n`));
