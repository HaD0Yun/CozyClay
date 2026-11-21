#!/usr/bin/env node
/**
 * verify.mjs — drive the MCP server the way a client does.
 *
 * Speaks real MCP over stdio against `server.mjs`, so this exercises the
 * transport, the schemas and the tool handlers together rather than importing
 * the handlers directly and hoping the wiring matches.
 *
 * The framing matrix is the important part: every size/view/level/side the
 * schema accepts must come back labelled the way it was asked for, because
 * `frame_shot` inverts geometry that `shot.js` owns. If shot.js retunes a band,
 * this fails loudly instead of quietly mis-framing.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));

const client = new Client({ name: "cozyclay-mcp-verify", version: "1.0.0" });
await client.connect(new StdioClientTransport({
	command: "node",
	args: [SERVER],
	env: { ...process.env, COZYCLAY_PROJECT_ROOT: fileURLToPath(new URL(".", import.meta.url)) },
}));

let failures = 0;
const check = (label, ok, detail = "") => {
	if (!ok) {
		failures += 1;
		console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
	}
};

const call = async (name, args = {}) => {
	const result = await client.callTool({ name, arguments: args });
	return result.content[0].text;
};

const slateOf = (body) => body.split("\n").find((line) => line.includes("·")) ?? "";

/* ------------------------------ tool surface ----------------------------- */

const { tools } = await client.listTools();
check("every tool has a description", tools.every((t) => t.description?.length > 20));
console.log(`${tools.length} tools registered`);

/* ---------------------------- framing matrix ----------------------------- */

const SIZES = [
	"extreme close-up",
	"close-up",
	"medium close-up",
	"medium shot",
	"medium-wide shot",
	"wide shot",
	"extreme wide shot",
];
const VIEWS = ["front", "front three-quarter", "profile", "rear three-quarter", "back"];
const LEVELS = ["ground", "low", "hip", "eye", "high", "overhead"];
const LEVEL_WORD = {
	ground: "ground level",
	low: "knee level",
	hip: "hip level",
	eye: "eye level",
	high: "high angle",
	overhead: "overhead",
};

let combinations = 0;
for (const size of SIZES) {
	for (const view of VIEWS) {
		for (const level of LEVELS) {
			for (const side of ["left", "right"]) {
				combinations += 1;
				const slate = slateOf(await call("frame_shot", { size, view, level, side, focal_mm: 35 }));
				const initial = side === "left" ? "L" : "R";
				const viewOk =
					view === "front"
						? slate.includes("· FRONT ·")
						: view === "back"
							? slate.includes("· BACK ·")
							: view === "profile"
								? slate.includes(`${side.toUpperCase()} PROFILE`)
								: slate.includes(view === "front three-quarter" ? "FRONT ¾" : "REAR ¾") &&
									slate.includes(initial);
				check(`${size} / ${view} / ${level} / ${side}`, slate.toLowerCase().includes(size) && slate.toLowerCase().includes(LEVEL_WORD[level]) && viewOk, slate);
			}
		}
	}
}
console.log(`${combinations} framing combinations checked`);

/* -------------------------------- the cast ------------------------------- */

await call("place_character", { character: "A", subject: "a detective in a wet trench coat" });
await call("add_character", { subject: "a courier holding a package", x: 1.6, z: 0.4, facing: -150 });
await call("add_character", { subject: "a street vendor", x: -2.2, z: 1.1, facing: 70 });

const cast = await call("describe_scene");
check("cast holds three characters", cast.includes("CAST (total: 3, returned: 3, truncated: false"), cast);
check("third character has its numbered label", /^\s+Character 3 /m.test(cast), cast);

const focused = await call("focus_character", { character: "B" });
check("focus follows the named character", focused.startsWith("Framing Character 2"), focused.split("\n")[0]);

const byId = await call("place_character", { character: cast.match(/^\s+Character 3 (\S+)/m)?.[1], facing: 12 });
check("character resolves by id", byId.startsWith("Character 3 updated"), byId.split("\n")[0]);

const bySlot = await call("place_character", { character: "3", facing: 15 });
check("character resolves by slot", bySlot.startsWith("Character 3 updated"), bySlot.split("\n")[0]);
const poses = Object.fromEntries([...cast.matchAll(/^\s+Character \d+ (\S+)/gm)].map((match, index) => [match[1], `TRANSPORT_POSE_${index}_SENTINEL`]));
const posed = await call("render_prompt", { mode: "image", environment: "an empty stage", pose_phrases: poses });
check("every ID-keyed pose crosses the real transport", Object.values(poses).every(pose => posed.split(pose).length === 2), posed);

check("unknown character is reported", (await call("place_character", { character: "Z" })).startsWith("No character"));

const removed = await call("remove_character", { character: "C" });
check("character removal works", removed.startsWith("Removed Character 3"), removed.split("\n")[0]);
check("cast shrinks after removal", removed.includes("CAST (total: 2, returned: 2, truncated: false"), removed);

// A rigless capsule figure joins the cast with its posture, and describe_scene
// names its model so an agent can tell it from a rig.
const proxy = await call("add_character", { subject: "a stand-in", model: "proxy-figure", posture: "sit", x: 0.5, z: 1 });
const proxyLine = proxy.split("\n").find((line) => /^\s+Character 3 /.test(line)) ?? "";
check("add_character model proxy-figure casts a capsule figure", proxyLine.includes("[proxy-figure]"), proxyLine);
check("describe_scene names the capsule figure's model", (await call("describe_scene")).includes("model: proxy-figure"));
const badPosture = await client.callTool({ name: "add_character", arguments: { subject: "a stand-in", model: "proxy-figure", posture: "kneel" } });
check("add_character refuses an unknown posture", badPosture.isError === true, JSON.stringify(badPosture));
check("capsule figure removal works", (await call("remove_character", { character: "C" })).startsWith("Removed Character 3"));

// An empty stage is legal: the last character can go, and the scene still
// describes and prompts without a cast.
await call("remove_character", { character: "B" });
const lastOne = await call("remove_character", { character: "A" });
check("the last character can be removed", lastOne.startsWith("Removed Character 1") && lastOne.includes("CAST (total: 0"), lastOne);
check("describe_scene reads an empty cast", (await call("describe_scene")).includes("CAST (total: 0"));
const emptyPrompt = await client.callTool({ name: "render_prompt", arguments: { mode: "video", environment: "an empty studio", style: "flat light" } });
check("render_prompt answers on an empty stage", emptyPrompt.isError !== true && typeof emptyPrompt.content?.[0]?.text === "string", JSON.stringify(emptyPrompt));

// Re-cast the pair the prompt checks below rely on.
await call("add_character", { subject: "a detective in a wet trench coat" });
await call("add_character", { subject: "a courier holding a package", x: 1.6, z: 0.4, facing: -150 });
const hiddenCast = await call("place_character", { character: "B", hidden: true });
const hiddenCastLine = hiddenCast.split("\n").find((line) => /^\s+Character 2 /.test(line)) ?? "";
check("place_character hidden marks the cast line", hiddenCastLine.includes(" hidden"), hiddenCastLine);
const shownCast = await call("place_character", { character: "B", hidden: false });
const shownCastLine = shownCast.split("\n").find((line) => /^\s+Character 2 /.test(line)) ?? "";
check("place_character hidden false clears the cast marker", !shownCastLine.includes(" hidden"), shownCastLine);

/* --------------------------------- the set ------------------------------- */

const placed = await call("place_object", { kind: "cylinder", x: -1.2, z: 0.6, facing: 30 });
const objectId = placed.match(/as (\S+)\./)?.[1];
check("place_object returns an id", Boolean(objectId), placed.split("\n")[0]);
check("update_object accepts the id", (await call("update_object", { id: objectId, scale: 1.4 })).startsWith("Updated"));
check("unknown object is reported", (await call("update_object", { id: "nope" })).startsWith("No object"));

/* -------------------- name & parent contract (regression) --------------- */
// place_object accepts an optional `name`; the created object carries it,
// and auto-numbering still works when the name is omitted.
// The id is the token right after "as "; a parented placement continues with
// " under <id>" before the period, so the id is whatever non-space run sits
// between "as " and the next space or period.
const idOf = (body) => body.split("\n")[0].match(/as (\S+?)(?=\s|\.)/)?.[1];

const named = await call("place_object", { kind: "cube", name: "Building A" });
const namedId = idOf(named);
check("place_object returns an id for a named object", Boolean(namedId), named.split("\n")[0]);
check("place_object honours a given name", named.split("\n")[0].includes("Building A"), named.split("\n")[0]);
const namedScene = await call("describe_scene");
check("describe_scene shows the given name", namedScene.includes("Building A"), namedScene);

const autoA = await call("place_object", { kind: "cube" });
const autoB = await call("place_object", { kind: "cube" });
check("unnamed object keeps the library label", autoA.split("\n")[0].includes("Cube") && !autoA.split("\n")[0].includes("Building A"), autoA.split("\n")[0]);
check("second unnamed object auto-numbers", autoB.split("\n")[0].includes("Cube 2"), autoB.split("\n")[0]);

// update_object accepts an optional `name`; renaming shows in describe_scene.
const renamed = await call("update_object", { id: namedId, name: "Building Renamed" });
check("update_object reflects the new name", renamed.includes("Building Renamed"), renamed.split("\n")[0]);
const renamedScene = await call("describe_scene");
check("describe_scene shows the renamed object", renamedScene.includes("Building Renamed"), renamedScene);
check("describe_scene drops the old name", !renamedScene.includes("Building A"), renamedScene);

const hiddenObject = await call("update_object", { id: namedId, hidden: true });
const hiddenObjectLine = hiddenObject.split("\n").find((line) => line.includes(namedId) && line.includes("yaw")) ?? "";
check("update_object hidden marks the set line", hiddenObjectLine.includes(" hidden"), hiddenObjectLine);
const shownObject = await call("update_object", { id: namedId, hidden: false });
const shownObjectLine = shownObject.split("\n").find((line) => line.includes(namedId) && line.includes("yaw")) ?? "";
check("update_object hidden false clears the set marker", !shownObjectLine.includes(" hidden"), shownObjectLine);

// place_object accepts an optional `parent`; the child is attached under the
// parent and is carried when the parent moves via update_object.
const parentPlaced = await call("place_object", { kind: "cube", name: "Parent Block" });
const parentId = idOf(parentPlaced);
check("place_object returns a parent id", Boolean(parentId), parentPlaced.split("\n")[0]);
const childPlaced = await call("place_object", { kind: "cube", name: "Child Block", parent: parentId });
const childId = idOf(childPlaced);
check("place_object returns a child id", Boolean(childId), childPlaced.split("\n")[0]);
check("place_object with parent reports the attachment", childPlaced.split("\n")[0].includes(`under ${parentId}`), childPlaced.split("\n")[0]);

const beforeMove = await call("describe_scene");
const childLineBefore = beforeMove.split("\n").find((line) => line.includes(childId)) ?? "";
const parentLineBefore = beforeMove.split("\n").find((line) => line.includes(parentId)) ?? "";
const childXBefore = Number(childLineBefore.match(/x (-?[\d.]+)/)?.[1] ?? NaN);
const parentXBefore = Number(parentLineBefore.match(/x (-?[\d.]+)/)?.[1] ?? NaN);

// describe_scene shows parent/child structure: the child line is visibly
// associated with the parent (indented under it or marked 'under <id>').
const indent = (line) => line.match(/^(\s*)/)?.[1].length ?? 0;
check(
	"describe_scene associates child with parent",
	childLineBefore.includes(`under ${parentId}`) || beforeMove.includes(`parent: ${parentId}`) || indent(childLineBefore) > indent(parentLineBefore),
	`${childLineBefore}\n${beforeMove}`,
);

const shift = 3.0;
await call("update_object", { id: parentId, x: parentXBefore + shift });
const afterMove = await call("describe_scene");
const childLineAfter = afterMove.split("\n").find((line) => line.includes(childId)) ?? "";
const childXAfter = Number(childLineAfter.match(/x (-?[\d.]+)/)?.[1] ?? NaN);
check(
	"moving parent carries child in x",
	Math.abs((childXAfter - childXBefore) - shift) < 0.05,
	`before x ${childXBefore}  after x ${childXAfter}  (shift ${shift})`,
);

// place_object with a `parent` id that does not exist returns an error
// mentioning the id; the object is not left dangling under a ghost parent.
const badParent = await call("place_object", { kind: "cube", parent: "no-such-parent" });
check("place_object with unknown parent reports the id", badParent.includes("no-such-parent"), badParent.split("\n")[0]);
const afterBad = await call("describe_scene");
check("place_object with unknown parent leaves no dangling child", !afterBad.includes("under no-such-parent"), afterBad);

/* ------------------------------ camera moves ----------------------------- */

check("move needs a mark", (await call("describe_camera_move")).startsWith("No A position"));
await call("frame_shot", { size: "medium close-up", view: "front", level: "eye", focal_mm: 85 });
await call("mark_camera_move");
await call("frame_shot", { size: "wide shot", view: "profile", level: "low", focal_mm: 24 });
const move = await call("describe_camera_move", { duration_s: 4 });
check("move is named", move.split("\n")[0].length > 0, move.split("\n")[0]);

/* --------------------------------- prompts ------------------------------- */

const prompt = await call("render_prompt", {
	mode: "video",
	model: "seedance_2",
	environment: "a rain-slicked Seoul alley at night",
	style: "shot on 35mm film",
	camera_move: "Dolly in",
});
check("prompt carries the framing", prompt.includes("wide shot") && prompt.includes("24mm"), prompt.slice(0, 120));
check("prompt carries both subjects", prompt.includes("detective") && prompt.includes("courier"));

/* ------------------------------- round-trip ------------------------------ */

const file = fileURLToPath(new URL("./.verify-project.cclayproject", import.meta.url));
const symlink = fileURLToPath(new URL("./.verify-project-link.cclayproject", import.meta.url));
const hardlink = fileURLToPath(new URL("./.verify-project-hardlink.cclayproject", import.meta.url));
const fs = await import("node:fs/promises");
await call("save_project", { path: file, name: "Verify" });
check("save refuses implicit overwrite", (await call("save_project", { path: file })).startsWith("Could not write"), "overwrite unexpectedly succeeded");
check("save allows explicit overwrite", (await call("save_project", { path: file, overwrite: true })).startsWith("Saved"), "explicit overwrite failed");
const reopened = await call("open_project", { path: file });
check("project round-trips the cast", reopened.includes("detective") && reopened.includes("courier"), reopened);
check("project round-trips the set", reopened.includes("Cylinder"), reopened);
await import("node:fs/promises").then((fs) => fs.unlink(file).catch(() => {}));

check("outside project root is rejected", (await call("open_project", { path: join(tmpdir(), "nope.cclayproject") })).includes("direct children of configured project root"));
check("wrong extension is rejected", (await call("open_project", { path: "/etc/hosts" })).includes("must end in .cclayproject"));
// Stay outside the configured project root (mcp/), but on the clone's filesystem:
// a system temp directory may be on another volume, where hard links fail with EXDEV.
const outsideDir = await fs.mkdtemp(new URL("../.verify-outside-", import.meta.url));
try {
	const outside = `${outsideDir}/sentinel.cclayproject`;
	await fs.writeFile(outside, "outside sentinel", { mode: 0o600 });
	// Windows creates symlinks only with Developer Mode or elevation; the hard-link checks still run.
	const linked = await fs.symlink(outside, symlink).then(() => true, (error) => {
		if (process.platform === "win32" && error.code === "EPERM") return false;
		throw error;
	});
	if (linked) {
		check("open refuses final symlink", (await call("open_project", { path: symlink })).startsWith("Could not read"), "symlink open unexpectedly succeeded");
		check("save refuses final symlink", (await call("save_project", { path: symlink, overwrite: true })).startsWith("Could not write"), "symlink overwrite unexpectedly succeeded");
		check("symlink target remains byte-identical", await fs.readFile(outside, "utf8") === "outside sentinel");
		await fs.unlink(symlink);
	} else console.log("SKIP final-symlink checks: this Windows account cannot create symlinks");
	await fs.link(outside, hardlink);
	check("external hard-link fixture has two links", (await fs.stat(hardlink)).nlink === 2);
	check("open refuses external hard link", (await call("open_project", { path: hardlink })).startsWith("Could not read"), "hard-link open unexpectedly succeeded");
	check("save refuses external hard link", (await call("save_project", { path: hardlink, overwrite: true })).startsWith("Could not write"), "hard-link overwrite unexpectedly succeeded");
	check("hard-link target remains byte-identical", await fs.readFile(outside, "utf8") === "outside sentinel");
} finally {
	await Promise.all([
		fs.rm(symlink, { force: true }),
		fs.rm(hardlink, { force: true }),
		fs.rm(outsideDir, { recursive: true, force: true }),
	]);
}

/* --------------------------------- result -------------------------------- */

await client.close();
if (failures > 0) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
