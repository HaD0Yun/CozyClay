#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { assignShards, parseShard, readDurations, readSelection, reportDurations, slowestFirst } from "./test-shards.mjs";

// Whatever a suite drives through the agent sidecar lands in a scratch
// session dir for the whole run, never in the author's ~/.config (#375).
if (!process.env.COZYCLAY_AGENT_SESSIONS_DIR) {
	const scratch = mkdtempSync(join(tmpdir(), "cozyclay-test-agent-sessions-"));
	process.env.COZYCLAY_AGENT_SESSIONS_DIR = scratch;
	process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
}

const NODE_FILES = [
	"test/motion3/verify-motion3-core.mjs", "test/motion3/verify-playback-frame-store.mjs", "test/verify-playback-render-isolation.mjs", "test/motion3/verify-motion3-idle.mjs", "test/motion3/verify-motion3-life.mjs", "test/motion3/verify-motion3-headlead.mjs", "test/motion3/verify-motion3-gait.mjs", "test/motion3/verify-motion3-overlap.mjs", "test/motion3/verify-motion3-flip.mjs", "test/motion3/verify-motion3-float-fix.mjs", "test/motion3/verify-motion3-timing.mjs", "test/motion3/verify-motion3-self.mjs", "test/motion3/verify-motion3-commands.mjs", "test/motion3/verify-motion3-exitcar.mjs", "test/motion3/verify-motion3-agentloop.mjs", "test/motion3/verify-motion3-search.mjs", "test/motion3/verify-motion3-skills.mjs", "test/motion3/verify-motion3-carried.mjs", "test/motion3/verify-motion3-people.mjs", "test/motion3/verify-motion3-hit.mjs", "test/motion3/verify-motion3-person-fix.mjs", "test/motion3/verify-motion3-socket.mjs", "test/motion3/verify-motion3-shapes.mjs", "test/motion3/verify-motion3-grasp-fields.mjs", "test/motion3/verify-motion3-finger-contact.mjs", "test/motion3/verify-motion3-finger-pose.mjs", "test/motion3/verify-motion3-grasp-qa.mjs", "test/motion3/verify-motion3-load.mjs", "test/motion3/verify-motion3-load-faces.mjs", "test/motion3/verify-motion3-throw.mjs", "test/motion3/verify-motion3-catch.mjs", "test/motion3/verify-motion3-spring.mjs", "test/motion3/verify-motion3-grasp-hints.mjs", "test/motion3/verify-motion3-ball-pickup-repair.mjs", "test/motion3/verify-motion3-reach-human.mjs", "test/motion3/verify-motion3-stance-grasp.mjs", "test/motion3/verify-motion3-grasp-friction.mjs", "test/motion3/verify-motion3-grasp-measure.mjs", "test/motion3/verify-motion3-contracts.mjs", "test/motion3/verify-motion3-describe.mjs", "test/motion3/verify-motion3-timeline.mjs", "test/motion3/verify-motion3-probes.mjs", "test/motion3/verify-motion3-grab.mjs", "test/motion3/verify-motion3-grab-blend.mjs", "test/motion3/verify-motion3-patch.mjs", "test/motion3/verify-motion3-patch-keys.mjs", "test/motion3/verify-motion3-stuck.mjs", "test/motion3/verify-motion3-repair.mjs", "test/motion3/verify-motion3-specstore.mjs", "test/motion3/verify-motion3-visual.mjs", "test/motion3/verify-motion3-goals.mjs", "test/motion3/verify-motion3-prompt.mjs", "test/motion3/verify-motion3-cup.mjs", "test/motion3/verify-motion3-arm.mjs", "test/motion3/verify-motion3-balance.mjs", "test/motion3/verify-motion3-box-hang.mjs", "test/motion3/verify-physics-overlay.mjs", "test/verify-proxy-figure.mjs", "test/verify-text-object.mjs", "test/motion3/verify-motion3-reach-coords.mjs", "test/motion3/verify-motion3-thin.mjs", "test/motion3/verify-motion3-sightline.mjs", "test/motion3/verify-motion3-shot-framing.mjs", "test/motion3/verify-motion3-ifclean.mjs", "test/motion3/verify-motion3-held-drift.mjs", "test/motion3/verify-motion3-patch-guard.mjs",
	"test/verify-proxy-figure-bounds.mjs",
	"test/verify-character-capabilities.mjs", "test/verify-test-shards.mjs", "test/verify-select-tests.mjs",
	"test/verify-root-path.mjs", "test/verify-tutorial-recorder.mjs", "test/motion3/verify-motion3-bricks.mjs", "test/motion3/verify-motion3-autofill.mjs", "test/motion3/verify-motion3-native.mjs", "test/verify-studio-task-scene-host.mjs", "test/motion3/verify-motion3-poses.mjs",
	"test/verify-studio-elements.mjs",
	"test/bus/verify-view-mode-pose.mjs",
	"test/verify-studio-actions.mjs",
	"test/ardy/verify-collision-blockers.mjs",
	"test/verify-pose-fade.mjs",
	"test/verify-pose-gizmo.mjs", "test/verify-fingertip-pick.mjs",
	"test/ardy/verify-key-runs.mjs",
	"test/ardy/verify-playback-clock.mjs",
	"test/ardy/verify-timeline-coordinates.mjs",
	"test/verify-tokens.mjs", "test/verify-lens-scrub.mjs",
	"test/demo/verify-api-routes.mjs",
	"test/ik/verify-collision-capsules.mjs", "test/ik/verify-ik-pick.mjs", "test/ik/verify-contact-project.mjs",
	"test/ik/verify-ground.mjs",
	"test/ik/verify-physics-review.mjs",
	"test/ik/verify-physics-support.mjs",
	"test/ik/verify-physics-surface.mjs",
	"test/ik/verify-ik.mjs",
	"test/ik/verify-knee-side.mjs",
	"test/ik/translation-step.mjs",
	"test/ik/verify-ik-drag-delta.mjs",
	"test/ik/verify-ik-blend-range.mjs",
	"test/ik/verify-range-pin.mjs",
	"test/ik/verify-range-pin-ui.mjs",
	"test/ik/verify-range-pin-object-transform.mjs",
	"test/verify-ik-camera-performance.mjs",
	"test/verify-ik-entry-camera.mjs", "test/verify-viewport-visible-rect.mjs", "test/verify-project-open-file.mjs",
	"test/process/verify-lifecycle.mjs",
	"test/process/verify-mcp-package-isolation.mjs",
	"test/process/verify-package-telemetry.mjs",
	"test/process/verify-agent-deps.mjs",
	"test/verify-agent-image-references.mjs",
	"test/verify-agent-panel.mjs", "test/verify-agent-turn-view.mjs", "test/verify-agent-plan.mjs", "test/verify-agent-reply-text.mjs", "test/verify-agent-sculpt-sketch.mjs",
	"test/verify-agent-host.mjs",
	"test/verify-agent-routes.mjs",
	"test/verify-studio-owner-restart.mjs",
	"test/verify-studio-agent-rebase.mjs", "test/bus/verify-studio-busy.mjs",
	"test/verify-agent-live-runtime.mjs",
	"test/verify-package-agent-imports.mjs",
	"test/verify-agent-runner-errors.mjs",
	"test/verify-agent-steer.mjs",
	"test/verify-pi-tools.mjs",
	"test/verify-agent-providers.mjs", "test/verify-agent-minimax.mjs", "test/verify-agent-login.mjs", "test/verify-agent-openai-compatible.mjs", "test/verify-anthropic-subscription.mjs",
	"test/verify-cliproxy-live-model.mjs",
	"test/verify-schema-to-typebox.mjs",
	"test/verify-agent-sse-golden.mjs",
	"test/verify-agent-context-budget.mjs", "test/verify-agent-context-trim.mjs", "test/verify-agent-context-meter.mjs",
	"test/verify-agent-supervisor.mjs", "test/verify-studio-tasks.mjs", "test/verify-task-board.mjs",
	"test/verify-studio-agent-protocol.mjs", "test/verify-studio-prompt-cast-style.mjs", "test/verify-task-text-intent.mjs",
	"test/verify-studio-agent-sampled-framing.mjs",
	"test/verify-studio-agent-tokens.mjs",
	"test/verify-agent-execution.mjs",
	"test/verify-workflow-execution.mjs",
	"test/verify-execution-shared-hooks.mjs",
	"mcp/verify-live-execution.mjs",
	"test/verify-canvas-commands.mjs",
	"test/verify-attachment-image.mjs",
	"test/verify-clipboard-image.mjs",
	"test/verify-codex-auth.mjs",
	"test/verify-analytics.mjs",
	"test/verify-appearance.mjs",
	"test/verify-auto-color.mjs",
	"test/verify-coplanar-depth.mjs",
	"test/verify-empty-object.mjs",
	"test/verify-sculpt-recipe.mjs", "test/verify-sculpt-shapes.mjs", "test/verify-sculpt-loft-convex.mjs", "test/verify-sculpt-detail.mjs",
	"test/verify-sculpt-object.mjs",
	"test/verify-sculpt-compare.mjs",
	"test/verify-sculpt-run.mjs",
	"test/verify-sculpt-compare-command.mjs",
	"test/verify-sculpt-panel.mjs",
	"test/verify-sculpt-blueprint.mjs",
	"test/verify-sculpt-mode.mjs", "test/verify-sculpt-csg.mjs", "test/verify-material-presets.mjs",
	"test/verify-route-owner.mjs",
	"test/verify-part-colours.mjs",
	"test/verify-asset-shelf.mjs",
	"test/verify-blocking-depth.mjs",
	"test/verify-render-passes-video.mjs",
	"test/verify-camera-block.mjs", "test/verify-camera-direction.mjs",
	"test/verify-camera-follow.mjs",
	"test/verify-camera-move.mjs",
	"test/verify-camera-rail-schedule.mjs",
	"test/verify-camera-pointer-lock.mjs",
	"test/verify-codex-client.mjs",
	"test/verify-cuts.mjs",
	"test/verify-shot-guides.mjs", "test/verify-shot-frame.mjs",
	"test/verify-error-boundary.mjs",
	"test/verify-g006-css.mjs",
	"test/verify-gizmo-claim.mjs",
	"test/verify-grid-view.mjs",
	"test/verify-hierarchy.mjs",
	"test/verify-history.mjs",
	"test/verify-image-versions.mjs",
	"test/verify-keyframe-pack.mjs",
	"test/verify-keyframe-pack-request.mjs",
	"test/verify-korean-ui.mjs", "test/verify-chinese-ui.mjs",
	"test/verify-label-tooltips.mjs",
	"test/verify-layout.mjs",
	"test/verify-beginner-screen.mjs",
	"test/verify-live-agent-commands.mjs",
	"test/verify-live-cli.mjs",
	"test/verify-live-control.mjs",
	"test/verify-matte-editor.mjs",
	"test/verify-matte.mjs",
	"test/verify-model-presets.mjs",
	"test/verify-mcp-invariants.mjs",
	"test/verify-offscreen-export.mjs", "test/verify-previs-workflow.mjs",
	"test/verify-export-capture.mjs",
	"test/verify-export-recovery.mjs", "test/verify-export-workspace.mjs",
	"test/verify-record-mp4-source.mjs",
	"test/verify-timeline-extent.mjs",
	"test/verify-otio.mjs",
	"test/verify-pose-library.mjs",
	"test/verify-project.mjs",
	"test/verify-workflow-send.mjs",
	"test/verify-animation-export.mjs",
	"test/verify-project-previs-mode.mjs", "test/verify-project-cast-style.mjs",
	"test/verify-pwa.mjs",
	"test/verify-package-signature.mjs",
	"test/verify-resilience.mjs",
	"test/verify-sample-at.mjs",
	"test/verify-scene-asset-cache.mjs",
	"test/verify-scene-assets.mjs",
	"test/verify-scene-mesh.mjs",
	"test/verify-mesh-sniff.mjs",
	"test/verify-mesh-graph-clone.mjs",
	"test/verify-scene-objects.mjs",
	"test/verify-studio-agent-geometry.mjs",
	"test/verify-studio-geometry-facts.mjs",
	"test/verify-plan-diagram.mjs",
	"test/verify-agent-plan-attach.mjs",
	"test/verify-local-placement.mjs",
	"test/verify-studio-agent-motion.mjs",
	"test/verify-studio-agent-binding.mjs",
	"test/verify-studio-agent-turn-undo.mjs",
	"test/verify-studio-undo-hygiene.mjs",
	"test/verify-studio-contact-sheet.mjs",
	"test/verify-reference-slots.mjs",
	"test/verify-scenes.mjs",
	"test/verify-character-kind.mjs",
	"test/verify-cozy-scene-node.mjs",
	"test/verify-motion-input.mjs",
	"test/verify-vibe-payload.mjs",
	"test/verify-vibe-node-schema.mjs",
	"test/verify-video-adapters.mjs",
	"test/verify-video-route.mjs",
	"test/verify-video-contract.mjs",
	"test/verify-local-workflow.mjs",
	"test/verify-workflow-scene-asset-sync.mjs",
	"test/verify-stable-ids.mjs",
	"test/verify-storyboard.mjs",
	"test/verify-shot-authoring.mjs",
	"test/verify-shot-document-v5.mjs",
	"test/verify-shot-meta.mjs",
	"test/verify-shot-prompt.mjs",
	"test/verify-shot-prompt-node.mjs",
	"test/verify-theme.mjs",
	"test/verify-telemetry-state.mjs",
	"test/verify-timeline-camera.mjs",
	"test/verify-shot-look.mjs",
	"test/verify-timeline-shots.mjs",
	"test/verify-still-shots.mjs",
	"test/verify-shot-cast-overrides.mjs",
	"test/verify-panel-stylize.mjs",
	"test/verify-tool-handlers.mjs",
	"test/verify-update-check.mjs", "test/verify-update-routes.mjs", "test/verify-update-client.mjs", "test/verify-star-prompt.mjs",
	"test/verify-usd-camera.mjs",
	"test/verify-zip-store.mjs",
	"test/verify-render-passes.mjs",
	"mcp/verify.mjs",
	"mcp/verify-http-origin.mjs",
	"mcp/verify-live.mjs",
	"mcp/verify-live-proxy-frame.mjs",
	"mcp/verify-live-p0.mjs",
	"mcp/verify-live-port.mjs",
	"mcp/verify-live-controller.mjs",
	"mcp/verify-live-routing.mjs",
	"mcp/verify-protocol-version.mjs",
	"mcp/verify-tool-annotations.mjs",
	"mcp/verify-import-mesh.mjs",
	"mcp/verify-sculpt-object.mjs", "mcp/verify-project-camera.mjs",
	"test/verify-object-path.mjs",
	"test/verify-object-travel.mjs",
	"test/verify-object-travel-lean.mjs",
	"test/verify-character-group.mjs",
	"test/verify-group-rotation.mjs",
	"test/verify-number-field-scrub.mjs",
	"test/verify-speed-envelope.mjs",
	"test/verify-project-resources.mjs",
	"test/verify-workflow-resources.mjs",
	"test/verify-resource-status.mjs",
];

const BROWSER_FILES = [
	"test/qa-proxy-entry-browser.mjs",
	"test/qa-previs-start-browser.mjs", "test/qa-shortcut-friction-browser.mjs", "test/qa-ik-contact-browser.mjs",
	"test/qa-storyboard-board-browser.mjs", "test/qa-sculpt-shelf-browser.mjs",
	"test/qa-storyboard-export-browser.mjs", "test/qa-playback-guide-browser.mjs",
	"test/qa-proxy-figure-browser.mjs", "test/qa-click-friction-browser.mjs", "test/qa-update-notice-browser.mjs", "test/qa-export-menu-browser.mjs",
	"test/qa-rail-lean-browser.mjs", "test/qa-sculpt-parts-browser.mjs",
	"test/qa-export-recovery-browser.mjs", "test/qa-export-workspace-browser.mjs",
	"test/verify-camera-mode-browser.mjs",
	"test/verify-camera-rail-browser.mjs",
	"test/verify-cutout-browser.mjs",
	"test/verify-mesh-browser.mjs",
	"test/verify-first-success-guide-browser.mjs",
	"test/verify-ik-browser.mjs",
	"test/verify-motion-edit-browser.mjs",
	"test/verify-number-field-scrub-browser.mjs",
	"test/verify-object-colour-browser.mjs",
	"test/verify-object-gizmo.mjs",
	"test/verify-offscreen-export-browser.mjs",
	"test/verify-project-menu-browser.mjs", "test/verify-previs-workflow-browser.mjs",
	"test/verify-project-session-reset.mjs",
	"test/verify-settings-menu-browser.mjs",
	"test/verify-static-shot-export-browser.mjs",
	"test/qa-agent-view-toggle-browser.mjs",
	"test/qa-agent-scenarios-browser.mjs",
	"test/qa-camera-pointer-lock-browser.mjs",
	"test/qa-first-edit-browser.mjs",
	"test/qa-ia-tail-browser.mjs",
	"test/qa-keyframe-pack-browser.mjs",
	"test/qa-preview-browser.mjs",
	"test/qa-reference-slots-browser.mjs",
	"test/qa-scene-playback-browser.mjs",
	"test/qa-scene-switcher-browser.mjs",
	"test/qa-send-to-ai-browser.mjs",
	"test/qa-execution-outcomes-browser.mjs",
	"test/qa-view-menu-browser.mjs",
	"test/qa-scenes-v5-migration-browser.mjs",
	"test/qa-clipboard-paste-browser.mjs",
	"test/qa-rail-ring-browser.mjs",
	"test/qa-rail-reach-browser.mjs",
	"test/qa-speed-graph-browser.mjs",
];

// The inventory sweep only picks up `verify*.mjs`; a browser suite named for
// the QA runner it needs is listed here so it still shows up in the manifest
// (as an EXCLUDE with its reason) instead of going unmentioned.
const EXTRA_INVENTORY = ["test/ik/translation-step.mjs", "test/qa-scenes-v5-migration-browser.mjs", "test/qa-agent-scenarios-browser.mjs", "test/qa-execution-outcomes-browser.mjs", "test/qa-export-recovery-browser.mjs", "test/qa-agent-view-toggle-browser.mjs", "test/qa-camera-pointer-lock-browser.mjs", "test/qa-first-edit-browser.mjs", "test/qa-ia-tail-browser.mjs", "test/qa-keyframe-pack-browser.mjs", "test/qa-preview-browser.mjs", "test/qa-reference-slots-browser.mjs", "test/qa-scene-playback-browser.mjs", "test/qa-scene-switcher-browser.mjs", "test/qa-send-to-ai-browser.mjs", "test/qa-view-menu-browser.mjs", "test/qa-live-reconnect-browser.mjs", "test/qa-clipboard-paste-browser.mjs", "test/qa-rail-lean-browser.mjs", "test/qa-rail-reach-browser.mjs", "test/qa-rail-ring-browser.mjs", "test/qa-speed-graph-browser.mjs", "test/qa-export-workspace-browser.mjs"];

EXTRA_INVENTORY.push("test/qa-proxy-figure-browser.mjs", "test/qa-click-friction-browser.mjs", "test/qa-update-notice-browser.mjs");
EXTRA_INVENTORY.push("test/qa-proxy-entry-browser.mjs", "test/qa-export-menu-browser.mjs");
EXTRA_INVENTORY.push("test/qa-previs-start-browser.mjs", "test/qa-shortcut-friction-browser.mjs", "test/qa-ik-contact-browser.mjs");
EXTRA_INVENTORY.push("test/qa-storyboard-board-browser.mjs", "test/qa-sculpt-parts-browser.mjs", "test/qa-sculpt-shelf-browser.mjs");
EXTRA_INVENTORY.push("test/qa-storyboard-export-browser.mjs", "test/qa-playback-guide-browser.mjs");

function verificationFiles(directory) {
	return readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return entry.name === "node_modules" ? [] : verificationFiles(path);
			return entry.isFile() && /^verify(-.*)?\.mjs$/.test(entry.name) ? [relative(".", path).replaceAll("\\", "/")] : [];
		})
		.sort();
}

// Every suite reserves its own ports and writes under a temp dir, so files
// are independent of each other; running them serially cost CI five minutes
// (#413). `--jobs 1` restores the old interleaved live output for debugging.
// `--shard INDEX/TOTAL` selects a deterministic slice for CI runners, balanced
// by the recorded seconds in tools/test-durations.json (tools/test-shards.mjs).
// Shards are disjoint and together cover the same runnable set as an unsharded
// invocation. `--durations-out PATH` writes each file's wall-clock seconds.
// `--only-from SELECTION.json` (tools/select-tests.mjs) narrows the runnable
// set before sharding; a shard left with no files passes.
function parseArguments(arguments_) {
	const options = { listOnly: false, scope: "all", jobs: Number(process.env.COZYCLAY_TEST_JOBS) || availableParallelism(), shard: null, durationsOut: null, onlyFrom: null };
	const valued = { "--scope": "scope", "--jobs": "jobs", "--shard": "shard", "--durations-out": "durationsOut", "--only-from": "onlyFrom" };
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--list") options.listOnly = true;
		else if (Object.hasOwn(valued, argument)) options[valued[argument]] = arguments_[(index += 1)] ?? "";
		else throw new Error(`unknown argument: ${argument}`);
	}
	options.jobs = Number(options.jobs);
	if (options.shard !== null) options.shard = parseShard(options.shard);
	if (options.scope !== "all" && options.scope !== "ardy") throw new Error(`unknown test scope: ${options.scope}`);
	if (!Number.isInteger(options.jobs) || options.jobs < 1) throw new Error(`--jobs must be a positive integer, got ${options.jobs}`);
	if (options.durationsOut === "" || options.onlyFrom === "") throw new Error("--durations-out and --only-from need a file path");
	return options;
}

// One file per child. With more than one job the output is buffered per file
// and replayed as a block when the file finishes, so PASS/FAIL lines of
// different suites never interleave. Each file's wall-clock seconds land in
// `timings` for --durations-out and the CI step summary.
const timings = new Map();
function run(file, { buffered }) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const started = performance.now();
		const child = spawn(process.execPath, [file], { stdio: buffered ? ["ignore", "pipe", "pipe"] : "inherit" });
		if (buffered) {
			child.stdout.on("data", (chunk) => chunks.push(chunk));
			child.stderr.on("data", (chunk) => chunks.push(chunk));
		}
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			timings.set(file, (performance.now() - started) / 1000);
			if (buffered) process.stdout.write(`\nRUNNING ${file}\n${Buffer.concat(chunks)}`);
			if (code === 0) resolve();
			else reject(new Error(`${file} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`));
		});
	});
}

// These suites reserve a port by binding :0, release it, and hand the number
// to a child that binds it again (or an adjacent one). Any concurrent suite
// can take it in between, so they run one at a time after the parallel wave
// instead of by luck. Everything else picks its port inside the process that
// keeps it.
const SERIAL_ONLY = new Set([
	"mcp/verify-http-origin.mjs",
	"mcp/verify-live-controller.mjs",
	"mcp/verify-live-p0.mjs",
	"mcp/verify-live-port.mjs",
	"mcp/verify-live-routing.mjs",
]);

async function runAll(files, jobs) {
	const queue = slowestFirst(files.filter((file) => !SERIAL_ONLY.has(file)), durations);
	let failure = null;
	const worker = async () => {
		while (queue.length > 0 && !failure) {
			const file = queue.shift();
			try {
				await run(file, { buffered: jobs > 1 });
			} catch (error) {
				failure ??= error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
	if (failure) throw failure;
	for (const file of files.filter((file) => SERIAL_ONLY.has(file))) await run(file, { buffered: true });
}

// node:sqlite's DatabaseSync only ships unflagged from Node 22.13.0 (it lived
// behind --experimental-sqlite before that). package.json requires >=22.19,
// but older 22.x installs are still common enough that the manifest should
// degrade gracefully instead of aborting the whole run.
const NODE_SQLITE_MIN = [22, 13, 0];
const NODE_SQLITE_FILES = [];

function meetsMinimumNodeVersion([major, minor, patch], current = process.versions.node) {
	const [currentMajor, currentMinor, currentPatch] = current.split(".").map(Number);
	if (currentMajor !== major) return currentMajor > major;
	if (currentMinor !== minor) return currentMinor > minor;
	return currentPatch >= patch;
}

const hasNodeSqlite = meetsMinimumNodeVersion(NODE_SQLITE_MIN);

// The MCP suites fork mcp/server.mjs, which imports the MCP SDK from
// mcp/node_modules — a tree the root `npm install` does not create. On a
// fresh clone those suites must degrade to an actionable EXCLUDE instead of
// a startup timeout that swallows the real ERR_MODULE_NOT_FOUND (CI installs
// them explicitly with `npm --prefix mcp ci`, so its coverage is unchanged).
// Every mcp/package.json dependency must be in mcp/node_modules itself: most of
// them also resolve from the root tree, which would hide a missing mcp install.
function hasMcpRuntimeDeps() {
	const { dependencies = {} } = JSON.parse(readFileSync(new URL("../mcp/package.json", import.meta.url), "utf8"));
	return Object.keys(dependencies).every((name) => existsSync(new URL(`../mcp/node_modules/${name}/package.json`, import.meta.url)));
}

const mcpDepsInstalled = hasMcpRuntimeDeps();
// Starts the repository hub through mcp/live-hub.mjs, so it needs that tree too.
const MCP_DEPENDENT_NODE_FILES = new Set(["test/verify-agent-live-runtime.mjs"]);

const categories = new Map([
	...NODE_FILES.map((file) => [file, { kind: "node", reason: "runs directly under Node" }]),
	["test/verify-studio-agent-tools.mjs", { kind: "node", reason: "runs directly under Node" }],
	["test/verify-agent-script-tool.mjs", { kind: "node", reason: "runs directly under Node" }],
	...BROWSER_FILES.map((file) => [file, { kind: "browser", reason: "requires the QA browser wrapper and a running Vite app" }]),
	["test/process/verify-mcp-package-isolation.mjs", { kind: "package-integration", reason: "installs the MCP runtime from the npm registry with an isolated cache" }],
	...["mcp/verify-live-batch.mjs", "mcp/verify-live-capture.mjs", "mcp/verify-live-editor-model.mjs", "mcp/verify-live-scene-parity.mjs", "test/qa-live-reconnect-browser.mjs"].map(
		(file) => [file, { kind: "browser", reason: "drives a real Chrome editor over the live socket" }],
	),
	...NODE_SQLITE_FILES.map((file) => [
		file,
		hasNodeSqlite
			? { kind: "node", reason: "runs directly under Node" }
			: {
					kind: "sqlite",
					reason: `requires node:sqlite, unflagged only from Node >=${NODE_SQLITE_MIN.join(".")} (current runtime is Node ${process.versions.node})`,
				},
	]),
]);
if (!mcpDepsInstalled) {
	for (const [file, category] of categories) {
		if (!(file.startsWith("mcp/") || MCP_DEPENDENT_NODE_FILES.has(file)) || category.kind !== "node") continue;
		categories.set(file, {
			kind: "mcp-deps",
			reason: "requires the MCP server dependencies; run `npm --prefix mcp ci` (or `cd mcp && npm install`) first",
		});
	}
}

const { listOnly, scope, jobs, shard, durationsOut, onlyFrom } = parseArguments(process.argv.slice(2));
const durations = readDurations();
const inventory = [...verificationFiles("test"), ...verificationFiles("mcp"), ...EXTRA_INVENTORY].sort();
for (const file of inventory) {
	if (/^test\/bus\/verify-.*\.mjs$/.test(file)) categories.set(file, { kind: "node", reason: "command bus contract verification" });
}
const unclassified = inventory.filter((file) => !categories.has(file));
const stale = [...categories.keys()].filter((file) => !inventory.includes(file));
if (unclassified.length > 0 || stale.length > 0) {
	throw new Error([
		unclassified.length > 0 ? `unclassified test files: ${unclassified.join(", ")}` : null,
		stale.length > 0 ? `missing classified test files: ${stale.join(", ")}` : null,
	].filter(Boolean).join("\n"));
}

const scoped = inventory.filter((file) => scope === "all" || file.startsWith("test/ardy/") || file.startsWith("test/ik/"));
const only = readSelection(onlyFrom);
const runnable = scoped.filter((file) => categories.get(file).kind === "node" && (!only || only.has(file)));
const { files: selected, predicted } = assignShards(runnable, durations, shard?.total ?? 1)[(shard?.current ?? 1) - 1];
const selectedSet = new Set(selected);
console.log(
	`TEST MANIFEST scope=${scope} runnable=${runnable.length} selected=${selected.length} total=${scoped.length} jobs=${jobs}${
		shard ? ` shard=${shard.current}/${shard.total}` : ""
	} predicted=${predicted.toFixed(1)}s`,
);
for (const file of scoped) {
	const { kind, reason } = categories.get(file);
	if (kind === "node" && only && !only.has(file)) console.log(`SKIP node ${file} - not selected by ${onlyFrom}`);
	else if (kind === "node" && shard && !selectedSet.has(file)) console.log(`SHARD node ${file} - assigned to another shard`);
	else console.log(`${kind === "node" ? "RUN" : "EXCLUDE"} ${kind} ${file} - ${reason}`);
}

if (!listOnly) {
	process.on("exit", () => reportDurations(timings, { out: durationsOut, selected: selected.length, predicted }));
	if (jobs === 1) {
		for (const file of selected) {
			console.log(`\nRUNNING ${file}`);
			await run(file, { buffered: false });
		}
	} else {
		await runAll(selected, jobs);
	}
	console.log(`\nPASS ${selected.length} Node verification files${shard ? ` (shard ${shard.current}/${shard.total})` : ""}`);
}
