// Live acceptance driver: ONE real Blender GUI instance attached to the real
// in-extension BlenderBridge, driven end to end against a scratch project.
//
// Guarded like the other live gates: it runs only when a Blender executable is
// resolvable AND CCLAY_LIVE_ACCEPTANCE=1 is set, so `npm test` stays hermetic.
//
// Re-run:
//   cd apps/cclay-extension && CCLAY_LIVE_ACCEPTANCE=1 node --import tsx --test test/live-acceptance.test.ts
//
// Evidence: /tmp/cclay-e2e-artifacts/ (results.json, revision-chain.json,
// journal-excerpt.jsonl, transcript.log, per-scenario thumbnails/files).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
	createReadImageTool,
	createRenderQaFramesTool,
} from "@cclay/blender-tools";
import {
	commitCameraPlanMutation,
	commitStageSceneMutation,
	createDirectorProjectStore,
} from "@cclay/director-runtime";
import {
	type CameraPlanV1,
	canonicalizeStageScenePlan,
	type DirectingAnalysisEvidenceV1,
	type SceneSnapshot,
	type StageSceneRequestV1,
	validateCameraPlan,
} from "@cclay/protocol";
import { BlenderBridge } from "../src/bridge.ts";
import { REPO_ADDON_VERSION } from "./addon-surface.ts";

const REPO_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const ARTIFACT_DIR = process.env.CCLAY_E2E_ARTIFACTS ?? "/tmp/cclay-e2e-artifacts";
const BLENDER_CANDIDATES = [
	process.env.CCLAY_BLENDER_EXECUTABLE,
	"/opt/homebrew/bin/blender",
	"/Applications/Blender.app/Contents/MacOS/Blender",
].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
const BLENDER = BLENDER_CANDIDATES.find((candidate) => existsSync(candidate));
const LIVE = process.env.CCLAY_LIVE_ACCEPTANCE === "1" && BLENDER !== undefined;

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==",
	"base64",
);

interface ScenarioRecord {
	status: "passed" | "failed";
	details: unknown;
	timings: { started_at: string; duration_ms: number };
}

test(
	"live acceptance: real Blender through the TS bridge",
	{ skip: LIVE ? false : "requires Blender and CCLAY_LIVE_ACCEPTANCE=1", timeout: 900_000 },
	async (t) => {
		mkdirSync(ARTIFACT_DIR, { recursive: true });
		const projectDir = path.join(ARTIFACT_DIR, `project-${Date.now()}`);
		mkdirSync(projectDir, { recursive: true });

		const transcript: string[] = [];
		const revisionChain: Array<{ revision: string; source: string }> = [];
		const results: Record<string, ScenarioRecord> = {};
		const productBugs: Array<{ scenario: string; summary: string; evidence: string }> = [];
		const log = (line: string) => {
			transcript.push(`${new Date().toISOString()} ${line}`);
		};
		const noteRevision = (revision: string, source: string) => {
			const last = revisionChain[revisionChain.length - 1];
			if (last?.revision !== revision) revisionChain.push({ revision, source });
		};
		const call = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
			log(`-> ${label}`);
			try {
				const value = await fn();
				log(`ok ${label}`);
				return value;
			} catch (error) {
				log(`FAIL ${label}: ${String(error)}`);
				throw error;
			}
		};
		const saveArtifact = (relative: string, bytes: Buffer | string) => {
			const target = path.join(ARTIFACT_DIR, relative);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, bytes);
			return target;
		};

		// Blender publishes project and bridge discovery; the TypeScript bridge is
		// a client of that Blender-owned listener.
		const ombDir = path.join(projectDir, ".cclay");

		// --- One real Blender (GUI: capture_viewport needs a 3D viewport) ---
		const blenderLogPath = path.join(ARTIFACT_DIR, "blender-stdout.log");
		const blenderLog = openSync(blenderLogPath, "w");
		let blender: ChildProcess | undefined = spawn(
			BLENDER!,
			[
				"--factory-startup",
				"--python",
				path.join(REPO_ROOT, "scripts/blender_attach.py"),
				"--python",
				path.join(REPO_ROOT, "apps/cclay-extension/test/live-acceptance-sidecar.py"),
				"--",
				"--cclay-project-dir",
				projectDir,
				"--cclay-repo",
				REPO_ROOT,
			],
			// detached: own process group, so the kill trap reaps Blender even when
			// BLENDER is a non-exec wrapper script (homebrew cask blender.wrapper.sh).
			{ env: { ...process.env, CCLAY_WATCH_MS: "0" }, stdio: ["ignore", blenderLog, blenderLog], detached: true },
		);
		const signalBlenderGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
			try {
				if (typeof child.pid === "number") process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				try {
					child.kill(signal);
				} catch {}
			}
		};
		const killBlender = (signal: NodeJS.Signals = "SIGTERM") => {
			if (blender === undefined) return;
			const child = blender;
			blender = undefined;
			signalBlenderGroup(child, signal);
			if (signal === "SIGTERM") {
				setTimeout(() => signalBlenderGroup(child, "SIGKILL"), 5_000).unref();
			}
		};
		process.on("exit", killBlender);
		process.on("SIGINT", killBlender);
		process.on("SIGTERM", killBlender);

		// --- Sidecar exec channel (raw bpy inside the live Blender) ---
		const commandDir = path.join(projectDir, ".cclay-e2e");
		mkdirSync(commandDir, { recursive: true });
		let commandCounter = 0;
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const blenderExec = async (label: string, code: string, timeoutMs = 90_000): Promise<unknown> => {
			commandCounter += 1;
			const stem = `cmd-${String(commandCounter).padStart(3, "0")}`;
			writeFileSync(path.join(commandDir, `${stem}.py`), code, "utf8");
			writeFileSync(path.join(commandDir, `${stem}.go`), "", "utf8");
			log(`-> blenderExec ${stem} (${label})`);
			const deadline = Date.now() + timeoutMs;
			const resultPath = path.join(commandDir, `${stem}.json`);
			while (!existsSync(resultPath)) {
				if (Date.now() > deadline) throw new Error(`sidecar command ${stem} (${label}) timed out`);
				await sleep(100);
			}
			const payload = JSON.parse(readFileSync(resultPath, "utf8")) as {
				ok: boolean;
				result?: unknown;
				error?: string;
			};
			if (!payload.ok) {
				log(`FAIL blenderExec ${stem}: ${payload.error}`);
				throw new Error(`sidecar command ${label} failed:\n${payload.error}`);
			}
			log(`ok blenderExec ${stem}`);
			return payload.result;
		};
		let bridge!: BlenderBridge;

		// --- Composed tool flows (mirrors src/index.ts wiring, zero prod edits) ---
		const stageScene = async (label: string, request: StageSceneRequestV1) =>
			call(`stage_scene ${label}`, async () => {
				const plan = canonicalizeStageScenePlan(request, randomUUID);
				const candidate = await bridge.stageScene(plan, {
					reportProgress: (progress) => log(`   stage_scene progress ${JSON.stringify(progress)}`),
				});
				const store = createDirectorProjectStore(projectDir);
				const result = await commitStageSceneMutation(store, plan, candidate);
				await bridge.finishDurableCommit(result.resulting_revision_id);
				noteRevision(result.resulting_revision_id, `stage_scene:${label}`);
				return result;
			});
		const applyCameraPlan = async (label: string, plan: CameraPlanV1) =>
			call(`apply_camera_plan ${label}`, async () => {
				const candidate = await bridge.applyCameraPlan(plan, {
					reportProgress: (progress) => log(`   apply_camera_plan progress ${JSON.stringify(progress)}`),
				});
				const store = createDirectorProjectStore(projectDir);
				const result = await commitCameraPlanMutation(store, plan, candidate);
				await bridge.finishDurableCommit(result.resulting_revision_id);
				noteRevision(result.resulting_revision_id, `apply_camera_plan:${label}`);
				return result;
			});
		const inspect = async (label: string) =>
			call(`inspect_project ${label}`, async () => {
				const result = await bridge.inspectProject();
				noteRevision(result.revision, `inspect_project:${label}`);
				return result;
			});
		const executeMutation = async (label: string, script: string, expectedRevision = bridge.revisionId) => {
			const response = await call(`execute_blender_python ${label}`, () =>
				bridge.executeBlenderPython({
					script,
					deadline_ms: 30_000,
					capture_stdout: true,
					expected_revision_id: expectedRevision,
				}),
			);
			assert.equal(response.type, "execute_result");
			assert.equal(response.outcome, "success");
			noteRevision(response.new_revision_id, `execute_blender_python:${label}`);
			return response;
		};

		const scenario = async (key: string, title: string, fn: () => Promise<unknown>) => {
			const startedAt = new Date().toISOString();
			const started = Date.now();
			await t.test(`${key} ${title}`, async () => {
				try {
					const details = await fn();
					results[key] = {
						status: "passed",
						details,
						timings: { started_at: startedAt, duration_ms: Date.now() - started },
					};
				} catch (error) {
					results[key] = {
						status: "failed",
						details: String((error as Error)?.stack ?? error),
						timings: { started_at: startedAt, duration_ms: Date.now() - started },
					};
					throw error;
				}
			});
		};

		const entityByName = (snapshot: SceneSnapshot, name: string) =>
			snapshot.objects.find((object) => object.name === name);

		try {
			// Blender owns project provisioning and bridge discovery. Do not start
			// the TypeScript client until both are durably published.
			await call("wait for .cclay/project.json", async () => {
				const deadline = Date.now() + 120_000;
				while (!existsSync(path.join(ombDir, "project.json"))) {
					if (Date.now() > deadline) throw new Error("Blender did not initialize the project in 120s");
					await sleep(250);
				}
			});
			await call("wait for .cclay/bridge-endpoint.json", async () => {
				const deadline = Date.now() + 120_000;
				while (!existsSync(path.join(ombDir, "bridge-endpoint.json"))) {
					if (Date.now() > deadline) throw new Error("Blender did not publish bridge discovery in 120s");
					await sleep(250);
				}
			});
			const project = JSON.parse(readFileSync(path.join(ombDir, "project.json"), "utf8")) as {
				project_id: string;
				current_revision_id: string;
			};
			bridge = new BlenderBridge(projectDir, { projectId: project.project_id });
			await bridge.start();
			await call("wait for bridge attach", () => bridge.waitForAttach(AbortSignal.timeout(120_000)));

			// ---------------- S1 attach-handshake ----------------
			await scenario("S1", "attach handshake accepts the repo addon surface", async () => {
				assert.equal(bridge.attached, true);
				assert.equal(bridge.attachFailure, undefined);
				assert.equal(bridge.attachedProjectId, project.project_id);
				assert.match(REPO_ADDON_VERSION ?? "", /^\d+\.\d+\.\d+$/, "manifest version is semver-shaped");
				const surface = (await blenderExec(
					"S1 capabilities",
					[
						"import bpy",
						"import cclay",
						"import cclay.connection as _connection",
						"_server = _connection._blender_server",
						"assert _server is not None",
						"result = {",
						'    "server_capabilities": sorted(_server.capabilities),',
						'    "addon_version": cclay.ADDON_VERSION,',
						'    "blender_version": bpy.app.version_string,',
						"}",
					].join("\n"),
				)) as {
					server_capabilities: string[];
					addon_version: string;
					blender_version: string;
				};
				assert.equal(surface.addon_version, REPO_ADDON_VERSION);
				assert.deepEqual(surface.server_capabilities, [
					"execute_blender_python_v1",
				]);
				const initial = await inspect("S1 initial");
				noteRevision(project.current_revision_id, "project.json initial");
				saveArtifact("s1/hello-surface.json", JSON.stringify(surface, null, 2));
				saveArtifact("s1/initial-snapshot.json", JSON.stringify(initial.snapshot, null, 2));
				return {
					project_id: project.project_id,
					blender_version: surface.blender_version,
					server_capabilities: surface.server_capabilities,
					addon_version: surface.addon_version,
					server_capability_count: surface.server_capabilities.length,
					initial_revision: initial.revision,
				};
			});

			// ---------------- S4 evidence -> camera plan ----------------
			// Runs while the durable base is still the V2 initial revision:
			// produce_directing_evidence binds the V2 substrate revision, which is
			// the durable truth right after project initialization (and after any
			// inspect rebind), matching the production first-directing-turn flow.
			await scenario("S4", "produce_directing_evidence digest authorizes apply_camera_plan", async () => {
				const before = await inspect("S4 base");
				const evidence = await call("produce_directing_evidence", () =>
					bridge.produceDirectingEvidence({ frame_start: 1, frame_end: 48 }),
				);
				noteRevision(evidence.revision_id, "produce_directing_evidence");
				assert.equal(evidence.revision_id, before.revision);
				assert.match(evidence.evidence_sha256, /^[0-9a-f]{64}$/);
				const evidenceDirectory = (await blenderExec(
					"S4 evidence directory",
					[
						"import bpy",
						"from cclay.directing_evidence import runtime_evidence_directory",
						'result = str(runtime_evidence_directory(bpy.context.scene["cclay.project_id"]))',
					].join("\n"),
				)) as string;
				const evidencePath = path.join(evidenceDirectory, `${evidence.evidence_sha256}.json`);
				const document = JSON.parse(readFileSync(evidencePath, "utf8")) as DirectingAnalysisEvidenceV1;
				saveArtifact("s4/evidence-document.json", JSON.stringify(document, null, 2));
				assert.equal(
					createHash("sha256").update(readFileSync(evidencePath)).digest("hex"),
					evidence.evidence_sha256,
				);

				// Two-keyframe smooth plan inside the framing band, on one side of
				// the action axis. framing_distance = 12 / tan(fov / 2) = 48.
				const fov = 2 * Math.atan(12 / 48);
				const center = document.analysis.subject_samples[0]!.center;
				const pose = (offset: [number, number, number]) => ({
					position: [center[0] + offset[0], center[1] + offset[1], center[2] + offset[2]] as [
						number,
						number,
						number,
					],
					look_at: [...center] as [number, number, number],
					up: [0, 1, 0] as [number, number, number],
					vertical_fov_radians: fov,
				});
				const plan: CameraPlanV1 = {
					schema_version: 1,
					expected_revision_id: evidence.revision_id,
					evidence_sha256: evidence.evidence_sha256,
					output_format: { width: 640, height: 360 },
					keyframes: [
						{ frame: 1, pose: pose([-3, 2, 14]), transition: "smooth" },
						{ frame: 40, pose: pose([-1, 2, 13]), transition: "smooth" },
					],
				};
				// Pre-validate with the repo's own pure validator so a driver-side
				// construction mistake never masquerades as a product failure.
				validateCameraPlan(plan, document);
				const applied = await applyCameraPlan("S4", plan);
				assert.match(applied.resulting_revision_id, /^[0-9a-f]{64}$/);

				const after = await inspect("S4 after apply");
				assert.equal(after.revision, applied.resulting_revision_id);
				const camera = entityByName(after.snapshot, "CCLAY Camera");
				assert.ok(camera?.entityId, "CCLAY Camera exists in the post-apply snapshot with an entity id");
				const detail = (await call("inspect_entity CCLAY Camera animation", () =>
					bridge.inspectEntity(camera!.entityId!, { scope: "animation" }),
				)) as { detail?: { animations?: Array<{ keyframes: Array<{ frame: number }> }> } };
				const keyedFrames = [
					...new Set(
						(detail.detail?.animations ?? []).flatMap((animation) =>
							animation.keyframes.map((keyframe) => keyframe.frame),
						),
					),
				].sort((left, right) => left - right);
				assert.deepEqual(keyedFrames, [1, 40], "camera keyframes exist at both planned frames");
				saveArtifact("s4/camera-animation.json", JSON.stringify(detail, null, 2));
				return {
					evidence_sha256: evidence.evidence_sha256,
					evidence_revision: evidence.revision_id,
					resulting_revision: applied.resulting_revision_id,
					camera_entity: camera!.entityId,
					keyed_frames: keyedFrames,
				};
			});

			// ---------------- S3 camera orbit + viewport captures ----------------
			await scenario("S3", "camera orbit changes capture_viewport thumbnails", async () => {
				const base = await inspect("S3 base");
				const camera = entityByName(base.snapshot, "Camera");
				assert.ok(camera?.entityId, "startup Camera has an entity id");
				await blenderExec(
					"S3 lock viewport to startup Camera",
					[
						"import bpy",
						'cam = bpy.data.objects["Camera"]',
						"window = bpy.context.window_manager.windows[0]",
						"configured = 0",
						"for area in window.screen.areas:",
						'    if area.type == "VIEW_3D":',
						"        space = area.spaces.active",
						"        space.use_local_camera = True",
						"        space.camera = cam",
						'        space.region_3d.view_perspective = "CAMERA"',
						"        configured += 1",
						"result = {'configured_viewports': configured}",
					].join("\n"),
				);
				const lookAtOrigin = (position: [number, number, number]) => {
					const length = Math.hypot(...position);
					const direction = position.map((component) => -component / length) as [number, number, number];
					const rx = Math.acos(-direction[2]);
					const rz = Math.atan2(-direction[0], direction[1]);
					return [rx, 0, rz] as [number, number, number];
				};
				const poses: Array<[number, number, number]> = [
					[9, 0, 4],
					[-4.5, 7.8, 4],
					[-4.5, -7.8, 4],
				];
				const captures: Array<{ file: string; bytes: number; width: number; height: number; sha256: string }> =
					[];
				const buffers: Buffer[] = [];
				for (const [index, position] of poses.entries()) {
					await executeMutation(
						`S3 pose ${index + 1}`,
						[
							"import bpy",
							`entity_id = ${JSON.stringify(camera!.entityId!)}`,
							"camera = next((object for object in bpy.data.objects if object.get('cclay.entity_id') == entity_id), None)",
							"if camera is None: raise RuntimeError(f'camera entity {entity_id} not found')",
							`camera.location = ${JSON.stringify(position)}`,
							`camera.rotation_euler = ${JSON.stringify(lookAtOrigin(position))}`,
							"bpy.context.view_layer.update()",
						].join("\n"),
					);
					const captured = await call(`capture_viewport pose ${index + 1}`, () => bridge.captureViewport());
					assert.equal(captured.views.length, 1, "a no-subject capture returns exactly one view");
					const view = captured.views[0]!;
					assert.equal(view.name, "viewport", "the no-subject view keeps its stable name");
					// The 2026-07 poisoning incident: a view without a mime type or
					// data becomes an image content block the model API refuses, and
					// the whole session dies. Assert both are present on every view.
					assert.ok(
						view.mime_type.startsWith("image/"),
						`view mime type is an image type, got ${view.mime_type}`,
					);
					assert.ok(view.data_base64.length > 0, "view carries base64 image data");
					const bytes = Buffer.from(view.data_base64, "base64");
					assert.ok(bytes.length > 0, "thumbnail is non-empty");
					assert.ok(
						view.width >= 1 && view.width <= 1024 && view.height >= 1 && view.height <= 1024,
						`thumbnail dimensions bounded, got ${view.width}x${view.height}`,
					);
					const extension = view.mime_type === "image/jpeg" ? "jpg" : "png";
					const file = saveArtifact(`s3/pose-${index + 1}.${extension}`, bytes);
					buffers.push(bytes);
					captures.push({
						file,
						bytes: bytes.length,
						width: view.width,
						height: view.height,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					});
				}
				const distinct = new Set(captures.map((capture) => capture.sha256));
				assert.ok(
					distinct.size >= 2,
					`at least two thumbnails differ byte-wise (got ${distinct.size} distinct of ${buffers.length})`,
				);
				// The subject path is the other half of the contract: named views
				// are synthesized from an owned entity's evaluated world bounds
				// without moving the camera, the viewport, or the entity. The
				// subject must be CCLAY-owned (cclay.owned_project_id), so stamp the
				// cube explicitly; a camera created by apply_camera_plan carries an
				// entity id but no ownership.
				const stagedSubject = await executeMutation(
					"S3 owned capture subject",
					[
						"import bpy",
						"import uuid",
						"bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1), rotation=(0, 0, 0), scale=(0.6, 0.6, 0.6))",
						'obj = bpy.context.active_object',
						'obj.name = "S3 Capture Subject"',
						'obj["cclay.entity_id"] = str(uuid.uuid4())',
						'obj["cclay.owned_project_id"] = bpy.context.scene["cclay.project_id"]',
						"bpy.context.view_layer.update()",
					].join("\n"),
				);
				const subjectSnapshot = await inspect("S3 owned capture subject");
				const subjectId = entityByName(subjectSnapshot.snapshot, "S3 Capture Subject")?.entityId;
				assert.ok(subjectId, "execute_blender_python created an identifiable staged subject");
				const multi = await call("capture_viewport subject two views", () =>
					bridge.captureViewport({ subject: subjectId!, views: ["three_quarter", "side"] }),
				);
				assert.deepEqual(
					multi.views.map((view) => view.name),
					["three_quarter", "side"],
					"named views come back in request order",
				);
				const multiBytes = multi.views.map((view) => {
					assert.ok(view.mime_type.startsWith("image/"), `subject view mime type, got ${view.mime_type}`);
					const decoded = Buffer.from(view.data_base64, "base64");
					assert.ok(decoded.length > 0, `subject view ${view.name} is non-empty`);
					saveArtifact(`s3/subject-${view.name}.jpg`, decoded);
					return createHash("sha256").update(decoded).digest("hex");
				});
				assert.notEqual(multiBytes[0], multiBytes[1], "two named views are two different images");
				// A synthesized capture must not move or delete anything; the
				// subject is still there afterwards, and the revision only moved
				// for the executed cube creation.
				const afterCapture = await inspect("S3 after subject capture");
				assert.equal(
					afterCapture.revision,
					stagedSubject.new_revision_id,
					"capture_viewport does not mutate the scene",
				);
				assert.ok(
					entityByName(afterCapture.snapshot, "S3 Capture Subject"),
					"the staged subject survives the capture",
				);
				await executeMutation(
					"S3 remove capture subject",
					[
						"import bpy",
						`entity_id = ${JSON.stringify(subjectId!)}`,
						"obj = next((object for object in bpy.data.objects if object.get('cclay.entity_id') == entity_id), None)",
						"if obj is None: raise RuntimeError(f'capture subject entity {entity_id} not found')",
						"bpy.data.objects.remove(obj, do_unlink=True)",
					].join("\n"),
					afterCapture.revision,
				);
				return { captures, distinct_thumbnails: distinct.size, subject_views: multiBytes };
			});

			// ---------------- S2 adopt + delete a pre-existing non-CCLAY cube ----------------
			await scenario("S2", "foreign cube: inspect shows it, adopt+delete removes it", async () => {
				const seeded = (await blenderExec(
					"S2 seed foreign cube",
					[
						"import bpy",
						"bpy.ops.mesh.primitive_cube_add(size=2, location=(2.5, -2.0, 1.0))",
						"obj = bpy.context.active_object",
						'obj.name = "E2E Intruder Cube"',
						"assert obj.get('cclay.owned_project_id') is None",
						"assert obj.get('cclay.entity_id') is None",
						"# Entity id assignment is the repo's canonical repair path; ownership stays foreign.",
						"bpy.ops.cclay.repair_ids()",
						"result = {",
						'    "name": obj.name,',
						'    "entity_id": obj.get("cclay.entity_id"),',
						'    "owned_project_id": obj.get("cclay.owned_project_id"),',
						"}",
					].join("\n"),
				)) as { name: string; entity_id: string; owned_project_id: unknown };
				assert.match(seeded.entity_id, /^[0-9a-f-]{36}$/);
				assert.equal(seeded.owned_project_id, null, "seeded cube carries no CCLAY ownership");

				const revisionBeforeSeedInspect = bridge.revisionId;
				const inspected = await inspect("S2 after seeding");
				const intruder = entityByName(inspected.snapshot, "E2E Intruder Cube");
				assert.ok(intruder, "inspect_project shows the seeded cube");
				assert.equal(intruder!.entityId, seeded.entity_id);
				saveArtifact("s2/snapshot-with-intruder.json", JSON.stringify(inspected.snapshot, null, 2));

				const adopted = await stageScene("S2 adopt", {
					schema_version: 1,
					expected_revision_id: inspected.revision,
					operations: [{ op: "adopt_entity", entity_id: seeded.entity_id }],
				});
				const staged = await executeMutation(
					"S2 delete adopted cube",
					[
						"import bpy",
						`entity_id = ${JSON.stringify(seeded.entity_id)}`,
						"obj = next((object for object in bpy.data.objects if object.get('cclay.entity_id') == entity_id), None)",
						"if obj is None: raise RuntimeError(f'adopted entity {entity_id} not found')",
						"bpy.data.objects.remove(obj, do_unlink=True)",
					].join("\n"),
					adopted.resulting_revision_id,
				);
				const after = await inspect("S2 after delete");
				assert.equal(after.revision, staged.new_revision_id);
				assert.equal(entityByName(after.snapshot, "E2E Intruder Cube"), undefined, "cube is gone");
				saveArtifact("s2/snapshot-after-delete.json", JSON.stringify(after.snapshot, null, 2));
				return {
					entity_id: seeded.entity_id,
					revision_before_seed_inspect: revisionBeforeSeedInspect,
					rebound_revision_with_intruder: inspected.revision,
					revision_after_delete: after.revision,
				};
			});

			// ---------------- S7 concurrent inspects ----------------
			await scenario("S7", "concurrent inspects all resolve FIFO with zero BUSY", async () => {
				const snapshot = (await inspect("S7 base")).snapshot;
				const entityIds = snapshot.objects
					.map((object) => object.entityId)
					.filter((entityId): entityId is string => typeof entityId === "string")
					.slice(0, 3);
				assert.equal(entityIds.length, 3, "at least three inspectable entities exist");
				const completionOrder: number[] = [];
				const track = <T>(index: number, promise: Promise<T>) =>
					promise.then((value) => {
						completionOrder.push(index);
						return value;
					});
				const settled = await Promise.allSettled([
					track(0, bridge.inspectProject()),
					track(1, bridge.inspectEntity(entityIds[0]!, { scope: "all" })),
					track(2, bridge.inspectEntity(entityIds[1]!, { scope: "all" })),
					track(3, bridge.inspectEntity(entityIds[2]!, { scope: "all" })),
				]);
				const failures = settled
					.map((outcome, index) => ({ outcome, index }))
					.filter(({ outcome }) => outcome.status === "rejected")
					.map(({ outcome, index }) => `#${index}: ${String((outcome as PromiseRejectedResult).reason)}`);
				const busy = failures.filter((failure) => failure.includes("BUSY"));
				assert.deepEqual(busy, [], "zero BUSY errors");
				assert.deepEqual(failures, [], "all four concurrent inspects resolve");
				assert.deepEqual(completionOrder, [0, 1, 2, 3], "FIFO: completion order equals submission order");
				return { entity_ids: entityIds, completion_order: completionOrder };
			});

			// ---------------- S5 stale revision fail-closed + rebind recovery ----------------
			await scenario("S5", "external mutation: stale revision, inspect rebind journal, recovery", async () => {
				const baseline = await inspect("S5 base");
				const oldRevision = baseline.revision;
				const cubeBefore = entityByName(baseline.snapshot, "Cube");
				assert.ok(cubeBefore?.entityId, "Cube entity exists before the external mutation");
				await blenderExec(
					"S5 external raw-bpy mutation",
					[
						"import bpy",
						'obj = bpy.data.objects["Cube"]',
						"obj.location.x += 1.75",
						"bpy.context.view_layer.update()",
						"result = {'cube_location': list(obj.location)}",
					].join("\n"),
				);
				let staleError: unknown;
				try {
					const response = await call("execute_blender_python S5 against stale base", () =>
						bridge.executeBlenderPython({
							script: [
								"import bpy",
								`entity_id = ${JSON.stringify(cubeBefore!.entityId!)}`,
								"cube = next((object for object in bpy.data.objects if object.get('cclay.entity_id') == entity_id), None)",
								"if cube is None: raise RuntimeError(f'cube entity {entity_id} not found')",
								"cube.location = (0, 0, 4)",
								"bpy.context.view_layer.update()",
							].join("\n"),
							deadline_ms: 30_000,
							capture_stdout: true,
							expected_revision_id: oldRevision,
						}),
					);
					if (response.type === "precondition_failed") {
						staleError = new Error(`REVISION_STALE: ${response.message}`);
					} else if (response.outcome !== "success") {
						staleError = new Error(`unexpected execution outcome: ${response.outcome}`);
					}
				} catch (error) {
					staleError = error;
				}
				assert.ok(staleError !== undefined, "execute_blender_python against the old revision must fail closed");
				assert.match(String(staleError), /REVISION_STALE/, `expected REVISION_STALE, got: ${String(staleError)}`);

				const rebound = await inspect("S5 rebind");
				assert.notEqual(rebound.revision, oldRevision, "inspect rebinds to a new revision");
				const journalPath = path.join(ombDir, "journal.jsonl");
				const journalLines = readFileSync(journalPath, "utf8")
					.split("\n")
					.filter((line) => line.trim().length > 0)
					.map((line) => JSON.parse(line) as Record<string, unknown>);
				const rebinds = journalLines.filter((entry) => entry.type === "inspect_rebind");
				assert.ok(rebinds.length > 0, "journal.jsonl gained inspect_rebind entries");
				const latest = rebinds[rebinds.length - 1]!;
				assert.equal(latest.new_revision_id, rebound.revision, "latest rebind binds the new revision");
				saveArtifact(
					"journal-excerpt.jsonl",
					`${rebinds.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
				);

				const cube = entityByName(rebound.snapshot, "Cube");
				assert.ok(cube?.entityId, "Cube entity survives the rebind");
				const recovered = await executeMutation(
					"S5 against rebound base",
					[
						"import bpy",
						`entity_id = ${JSON.stringify(cube!.entityId!)}`,
						"cube = next((object for object in bpy.data.objects if object.get('cclay.entity_id') == entity_id), None)",
						"if cube is None: raise RuntimeError(f'cube entity {entity_id} not found')",
						"cube.location = (0, 0, 4)",
						"bpy.context.view_layer.update()",
					].join("\n"),
					rebound.revision,
				);
				return {
					old_revision: oldRevision,
					stale_error: String(staleError),
					rebound_revision: rebound.revision,
					inspect_rebind_entries: rebinds.length,
					latest_rebind: latest,
					recovered_revision: recovered.new_revision_id,
				};
			});

			// ---------------- S4b evidence after child commits ----------------
			// Formerly a recorded product bug (S4-probe in product-bugs.json):
			// produce_directing_evidence bound the raw V2 substrate revision, so
			// after S5's stage_scene child commits it failed with
			// INVALID_PRODUCE_EVIDENCE_RESULT. Evidence now binds the durable
			// project index (current_revision_id + manifest sceneHash), so the
			// stage-then-direct-cameras flow works without an inspect rebind.
			await scenario("S4b", "produce_directing_evidence binds the durable child revision after stage_scene commits", async () => {
				const before = bridge.revisionId;
				const evidence = await call("produce_directing_evidence after child commit", () =>
					bridge.produceDirectingEvidence({ frame_start: 1, frame_end: 48 }),
				);
				noteRevision(evidence.revision_id, "produce_directing_evidence:S4b");
				assert.equal(
					evidence.revision_id,
					before,
					"evidence binds the durable child revision without an inspect rebind",
				);
				assert.match(evidence.evidence_sha256, /^[0-9a-f]{64}$/);
				const evidenceDirectory = (await blenderExec(
					"S4b evidence directory",
					[
						"import bpy",
						"from cclay.directing_evidence import runtime_evidence_directory",
						'result = str(runtime_evidence_directory(bpy.context.scene["cclay.project_id"]))',
					].join("\n"),
				)) as string;
				const evidencePath = path.join(evidenceDirectory, `${evidence.evidence_sha256}.json`);
				const document = JSON.parse(readFileSync(evidencePath, "utf8")) as DirectingAnalysisEvidenceV1;
				saveArtifact("s4b/evidence-document.json", JSON.stringify(document, null, 2));
				assert.equal(document.revision_id, evidence.revision_id);

				const fov = 2 * Math.atan(12 / 48);
				const center = document.analysis.subject_samples[0]!.center;
				const pose = (offset: [number, number, number]) => ({
					position: [center[0] + offset[0], center[1] + offset[1], center[2] + offset[2]] as [
						number,
						number,
						number,
					],
					look_at: [...center] as [number, number, number],
					up: [0, 1, 0] as [number, number, number],
					vertical_fov_radians: fov,
				});
				const plan: CameraPlanV1 = {
					schema_version: 1,
					expected_revision_id: evidence.revision_id,
					evidence_sha256: evidence.evidence_sha256,
					output_format: { width: 640, height: 360 },
					keyframes: [
						{ frame: 1, pose: pose([-3, 2, 14]), transition: "smooth" },
						{ frame: 40, pose: pose([-1, 2, 13]), transition: "smooth" },
					],
				};
				validateCameraPlan(plan, document);
				const applied = await applyCameraPlan("S4b", plan);
				assert.match(applied.resulting_revision_id, /^[0-9a-f]{64}$/);
				const after = await inspect("S4b after apply");
				assert.equal(after.revision, applied.resulting_revision_id);
				return {
					evidence_sha256: evidence.evidence_sha256,
					evidence_revision: evidence.revision_id,
					pre_produce_revision: before,
					resulting_revision: applied.resulting_revision_id,
				};
			});

			// ---------------- S8 render thumbnail budget ----------------
			await scenario("S8", "render_qa_frames: model sees <64KB JPEG, PNG artifact streamed", async () => {
				await inspect("S8 sync");
				const tool = createRenderQaFramesTool(bridge);
				const request = { schema_version: 1 as const, revision_id: bridge.revisionId, frames: [1] };
				const outcome = (await call("render_qa_frames frame 1", () =>
					Promise.resolve(tool.execute("live-acceptance-s8", request, undefined, undefined, undefined as never)),
				)) as {
					content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
					details: {
						frames: Array<{
							frame: number;
							byte_length: number;
							sha256: string;
							uri: string;
							thumbnail: { mime_type: string; data_base64: string };
						}>;
					};
				};
				const imageBlocks = outcome.content.filter((block) => block.type === "image");
				assert.equal(imageBlocks.length, 1, "exactly one model-visible image block");
				const thumbnail = Buffer.from(imageBlocks[0]!.data!, "base64");
				assert.equal(imageBlocks[0]!.mimeType, "image/jpeg", "model-visible content is the JPEG thumbnail");
				assert.ok(
					thumbnail.length < 64 * 1024,
					`model-visible thumbnail stays under 64KB (${thumbnail.length} bytes)`,
				);
				const frame = outcome.details.frames[0]!;
				assert.equal(frame.uri, `cclay-artifact://sha256/${frame.sha256}`);
				const artifactPath = path.join(ombDir, "artifacts", "sha256", `${frame.sha256}.png`);
				const artifactBytes = readFileSync(artifactPath);
				assert.equal(artifactBytes.length, frame.byte_length, "full PNG bytes present in the artifact store");
				assert.equal(
					createHash("sha256").update(artifactBytes).digest("hex"),
					frame.sha256,
					"artifact sha256 matches",
				);
				assert.deepEqual(
					[...artifactBytes.subarray(0, 8)],
					[137, 80, 78, 71, 13, 10, 26, 10],
					"artifact is a PNG",
				);
				saveArtifact("s8/thumbnail.jpg", thumbnail);
				saveArtifact("s8/artifact.png", artifactBytes);
				return {
					thumbnail_bytes: thumbnail.length,
					artifact_bytes: artifactBytes.length,
					artifact_sha256: frame.sha256,
					uri: frame.uri,
				};
			});

			// ---------------- S6 read_image under the real $TMPDIR ----------------
			await scenario("S6", "read_image accepts a PNG under the real $TMPDIR", async () => {
				const tmpRoot = process.env.TMPDIR ?? "/tmp";
				const imagePath = path.join(tmpRoot, `cclay-e2e-read-image-${process.pid}.png`);
				writeFileSync(imagePath, PNG_1X1);
				try {
					const tool = createReadImageTool(projectDir);
					const outcome = (await tool.execute(
						"live-acceptance-s6",
						{ path: imagePath },
						undefined,
						undefined,
						undefined as never,
					)) as { content: Array<{ type: string; mimeType?: string }>; details: { bytes: number } };
					assert.equal(outcome.content[0]?.type, "image", "an image content block is returned");
					assert.equal(outcome.content[0]?.mimeType, "image/png");
					assert.equal(outcome.details.bytes, PNG_1X1.length);
					return { image_path: imagePath, tmpdir: tmpRoot, bytes: outcome.details.bytes };
				} finally {
					rmSync(imagePath, { force: true });
				}
			});

			// ---------------- S9 multi-frame batch survives the wire ----------------
			await scenario("S9", "render_qa_frames: a 5-frame batch does not sever the bridge", async () => {
				// Regression: the result message restated every full PNG, so this exact
				// 5-frame batch exceeded the addon's 1 MiB WebSocket frame limit and
				// the transport was dropped mid-call with a bare BRIDGE_DISCONNECTED.
				const frames = [1, 80, 120, 150, 160];
				await inspect("S9 sync");
				await stageScene("S9 frame range", {
					schema_version: 1,
					expected_revision_id: bridge.revisionId,
					operations: [{ op: "set_render_settings", frame_start: 1, frame_end: 160 }],
				});
				const tool = createRenderQaFramesTool(bridge);
				const outcome = (await call(`render_qa_frames ${frames.length} frames`, () =>
					Promise.resolve(
						tool.execute(
							"live-acceptance-s9",
							{ schema_version: 1 as const, revision_id: bridge.revisionId, frames },
							undefined,
							undefined,
							undefined as never,
						),
					),
				)) as {
					content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
					details: {
						frames: Array<{ frame: number; byte_length: number; sha256: string; uri: string }>;
					};
				};

				// The bridge is still attached: the batch crossed the wire intact.
				assert.equal(bridge.attached, true, "bridge survived the multi-frame batch");
				assert.equal(bridge.attachFailure, undefined);

				assert.deepEqual(
					outcome.details.frames.map((frame) => frame.frame),
					frames,
					"every requested frame came back",
				);
				const imageBlocks = outcome.content.filter((block) => block.type === "image");
				assert.equal(imageBlocks.length, frames.length, "one thumbnail per frame");
				let modelBytes = 0;
				for (const block of imageBlocks) {
					assert.equal(block.mimeType, "image/jpeg");
					modelBytes += Buffer.from(block.data!, "base64").byteLength;
				}

				// Full PNGs live only in the artifact store. The invariant under test is
				// scene-independent: the result payload must not scale with PNG size, so
				// no batch can push it past the bridge message budget.
				let artifactBytes = 0;
				for (const frame of outcome.details.frames) {
					const artifact = readFileSync(path.join(ombDir, "artifacts", "sha256", `${frame.sha256}.png`));
					assert.equal(artifact.length, frame.byte_length, `frame ${frame.frame} artifact is complete`);
					assert.equal(createHash("sha256").update(artifact).digest("hex"), frame.sha256);
					assert.deepEqual([...artifact.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
					assert.equal("image" in (frame as Record<string, unknown>), false, "no restated PNG");
					artifactBytes += artifact.length;
				}
				const resultPayloadBytes = Buffer.byteLength(JSON.stringify(outcome.details), "utf8");
				const restatedPayloadBytes = resultPayloadBytes + Math.ceil((artifactBytes * 4) / 3);
				assert.ok(
					resultPayloadBytes < artifactBytes,
					`result payload (${resultPayloadBytes}) does not carry the PNGs (${artifactBytes})`,
				);
				assert.ok(
					resultPayloadBytes < 983_040,
					`result payload stays inside the bridge message budget (${resultPayloadBytes} bytes)`,
				);
				assert.ok(modelBytes < 64 * 1024, `model-visible batch stays small (${modelBytes} bytes)`);

				// A follow-up op proves the link is usable, not merely still open.
				const after = await inspect("S9 after batch");
				return {
					frames,
					artifact_bytes: artifactBytes,
					model_visible_bytes: modelBytes,
					result_payload_bytes: resultPayloadBytes,
					old_shape_payload_bytes: restatedPayloadBytes,
					revision_after: after.revision,
				};
			});
			// ---------------- S10 standalone execute_blender_python success ----------------
			await scenario("S10", "execute_blender_python commits one revision and exposes Unicode stdout", async () => {
				const baseRevision = bridge.revisionId;
				const response = await call("execute_blender_python S10 happy", () =>
					bridge.executeBlenderPython({
						script: [
							"import bpy",
							'bpy.context.scene["cclay.e2e_execute_happy"] = "mutated"',
							'print("S10 Unicode: ✓ 雪")',
						].join("\n"),
						deadline_ms: 30_000,
						capture_stdout: true,
						expected_revision_id: baseRevision,
					}),
				);
				assert.equal(response.type, "execute_result");
				assert.equal(response.outcome, "success");
				assert.notEqual(response.new_revision_id, baseRevision, "successful execution mints exactly one child revision");
				assert.match(response.new_revision_id, /^[0-9a-f]{64}$/);
				assert.match(response.stdout, /S10 Unicode: ✓ 雪/);
				assert.equal(response.stdout_truncated, false);
				assert.equal(bridge.revisionId, response.new_revision_id, "bridge adopts the execution child revision");
				const durable = JSON.parse(readFileSync(path.join(ombDir, "project.json"), "utf8")) as {
					current_revision_id: string;
				};
				assert.equal(durable.current_revision_id, response.new_revision_id, "project.json durably records the child revision");
				const journal = JSON.parse(
					readFileSync(path.join(ombDir, "execution-journal", `${response.request_id}.json`), "utf8"),
				) as { status: string; base_revision_id: string; new_revision_id?: string };
				assert.equal(journal.status, "finalized");
				assert.equal(journal.base_revision_id, baseRevision);
				assert.equal(journal.new_revision_id, response.new_revision_id);
				const observed = await blenderExec(
					"S10 observe standalone execution mutation",
					'import bpy\nresult = bpy.context.scene.get("cclay.e2e_execute_happy")',
				);
				assert.equal(observed, "mutated", "sidecar observes the Blender scene mutation");
				noteRevision(response.new_revision_id, "execute_blender_python:S10");
				saveArtifact("s10/execution-journal.json", JSON.stringify(journal, null, 2));
				return {
					base_revision: baseRevision,
					new_revision: response.new_revision_id,
					request_id: response.request_id,
					journal_status: journal.status,
					stdout: response.stdout,
				};
			});

			// ---------------- S11 standalone execute_blender_python exception/reload ----------------
			await scenario("S11", "execute_blender_python exception reloads the backup and reconnects a fresh generation", async () => {
				const baseRevision = bridge.revisionId;
				const endpointBefore = JSON.parse(readFileSync(path.join(ombDir, "bridge-endpoint.json"), "utf8")) as {
					token_generation: number;
				};
				const response = await call("execute_blender_python S11 exception", () =>
					bridge.executeBlenderPython({
						script: [
							"import bpy",
							'bpy.ops.mesh.primitive_cube_add(); bpy.context.object.name = "CCLAY S11 transient"',
							'print("S11 before exception")',
							'raise RuntimeError("S11 deliberate exception")',
						].join("\n"),
						deadline_ms: 30_000,
						capture_stdout: true,
						expected_revision_id: baseRevision,
					}),
				);
				assert.equal(response.type, "execute_result");
				assert.equal(response.outcome, "failed_recovered");
				assert.equal(response.restored_revision_id, baseRevision, "recovery restores the exact execution base");
				assert.equal(bridge.revisionId, baseRevision, "bridge resets to the recovered base revision");
				const endpointDeadline = Date.now() + 120_000;
				let endpointAfter = endpointBefore;
				while (endpointAfter.token_generation <= endpointBefore.token_generation) {
					if (Date.now() > endpointDeadline) throw new Error("recovery did not publish a fresh bridge generation in 120s");
					await sleep(100);
					endpointAfter = JSON.parse(readFileSync(path.join(ombDir, "bridge-endpoint.json"), "utf8")) as {
						token_generation: number;
					};
				}
				await bridge.waitForAttach(AbortSignal.timeout(120_000));
				assert.equal(bridge.attached, true);
				assert.ok(
					endpointAfter.token_generation > endpointBefore.token_generation,
					"recovery endpoint generation strictly increases",
				);
				const durable = JSON.parse(readFileSync(path.join(ombDir, "project.json"), "utf8")) as {
					current_revision_id: string;
				};
				assert.equal(durable.current_revision_id, baseRevision, "failed execution creates no durable child revision");
				const journal = JSON.parse(
					readFileSync(path.join(ombDir, "execution-journal", `${response.request_id}.json`), "utf8"),
				) as { status: string; base_revision_id: string; backup_path: string };
				assert.equal(journal.status, "recovered");
				assert.equal(journal.base_revision_id, baseRevision);
				assert.ok(existsSync(journal.backup_path), "recovery journal retains the verified backup used for reload");
				const readable = await inspect("S11 read after recovery");
				assert.equal(
					readable.snapshot.objects.some((object) => object.name === "CCLAY S11 transient"),
					false,
					"object created before the exception is absent after backup reload",
				);
				const queried = await call("get_execution_outcome S11", () => bridge.getExecutionOutcome(response.request_id));
				assert.equal(queried.type, "execute_result");
				assert.equal(queried.outcome, "failed_recovered");
				assert.equal(queried.restored_revision_id, baseRevision);
				assert.equal(readable.revision, baseRevision, "reads remain usable after the reconnect");
				const bridgeLogDeadline = Date.now() + 5_000;
				let bridgeLog = "";
				while (!bridgeLog.includes(`"event":"bridge_disconnect","request_id":"${response.request_id}"`)) {
					if (Date.now() > bridgeLogDeadline) {
						throw new Error("bridge log did not record the execution recovery disconnect");
					}
					await sleep(100);
					bridgeLog = existsSync(path.join(ombDir, "bridge.log"))
						? readFileSync(path.join(ombDir, "bridge.log"), "utf8")
						: "";
				}
				saveArtifact("s11/execution-journal.json", JSON.stringify(journal, null, 2));
				saveArtifact(
					"s11/endpoints.json",
					JSON.stringify({ before: endpointBefore, after: endpointAfter }, null, 2),
				);
				return {
					base_revision: baseRevision,
					request_id: response.request_id,
					journal_status: journal.status,
					token_generation_before: endpointBefore.token_generation,
					token_generation_after: endpointAfter.token_generation,
				};
			});
			// ---------------- S12 crash-mid-script conservative outcome ----------------
			await scenario("S12", "execute_blender_python SIGKILL leaves a started journal and freezes mutations", async () => {
				const baseRevision = bridge.revisionId;
				const journalDirectory = path.join(ombDir, "execution-journal");
				const beforeJournalNames = new Set(existsSync(journalDirectory) ? readdirSync(journalDirectory) : []);
				const pending = bridge.executeBlenderPython({
					script: [
						"import bpy",
						"import time",
						'bpy.context.scene["cclay.e2e_crash_mid_script"] = "written before SIGKILL"',
						"time.sleep(60)",
					].join("\n"),
					deadline_ms: 30_000,
					capture_stdout: true,
					expected_revision_id: baseRevision,
				});
				const journalDeadline = Date.now() + 15_000;
				let journalPath: string | undefined;
				let journal: { request_id: string; status: string; base_revision_id: string } | undefined;
				while (journal?.status !== "started") {
					if (Date.now() > journalDeadline) throw new Error("S12 execution journal did not reach started in 15s");
					const name = readdirSync(journalDirectory).find(
						(candidate) => !beforeJournalNames.has(candidate) && candidate.endsWith(".json"),
					);
					if (name !== undefined) {
						journalPath = path.join(journalDirectory, name);
						journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
							request_id: string;
							status: string;
							base_revision_id: string;
						};
					}
					await sleep(100);
				}
				assert.equal(journal.base_revision_id, baseRevision);
				killBlender("SIGKILL");
				const outcome = await Promise.race([
					pending,
					sleep(50_000).then(() => {
						throw new Error("S12 did not resolve a conservative execution outcome in 50s");
					}),
				]);
				assert.equal(outcome.type, "execute_result");
				assert.equal(outcome.outcome, "outcome_unknown", "SIGKILL must not fabricate success or recovery");
				assert.equal(bridge.executionMutationFrozen, true, "unknown execution freezes future mutations");
				const afterKillJournal = JSON.parse(readFileSync(journalPath!, "utf8")) as {
					request_id: string;
					status: string;
					base_revision_id: string;
				};
				assert.equal(afterKillJournal.status, "started", "SIGKILL leaves the durable journal started");
				await assert.rejects(
					bridge.executeBlenderPython({
						script: "pass",
						deadline_ms: 1,
						capture_stdout: false,
						expected_revision_id: baseRevision,
					}),
					/EXECUTION_RECOVERY_REQUIRED|MUTATION_BRIDGE_UNAVAILABLE/,
				);
				saveArtifact("s12/execution-journal-started.json", JSON.stringify(afterKillJournal, null, 2));
				saveArtifact(
					"s12/crash-evidence.json",
					JSON.stringify(
						{
							base_revision: baseRevision,
							request_id: afterKillJournal.request_id,
							outcome: outcome.outcome,
							execution_mutation_frozen: bridge.executionMutationFrozen,
							journal_status: afterKillJournal.status,
						},
						null,
						2,
					),
				);
				return {
					base_revision: baseRevision,
					request_id: afterKillJournal.request_id,
					outcome: outcome.outcome,
					journal_status: afterKillJournal.status,
				};
			});
		} finally {
			// Trap: always kill the spawned Blender and close the TypeScript client.
			killBlender();
			// Bounded: closing the client must not delay artifact receipts after
			// Blender owns listener shutdown with its process lifetime.
			await Promise.race([bridge?.close().catch(() => {}), sleep(15_000)]);

			saveArtifact("results.json", `${JSON.stringify(results, null, 2)}\n`);
			saveArtifact("revision-chain.json", `${JSON.stringify(revisionChain, null, 2)}\n`);
			saveArtifact("transcript.log", `${transcript.join("\n")}\n`);
			saveArtifact("product-bugs.json", `${JSON.stringify(productBugs, null, 2)}\n`);
			saveArtifact(
				"run-metadata.json",
				`${JSON.stringify(
					{
						blender: BLENDER,
						repo_root: REPO_ROOT,
						project_dir: projectDir,
						rerun:
							"cd apps/cclay-extension && CCLAY_LIVE_ACCEPTANCE=1 node --import tsx --test test/live-acceptance.test.ts",
					},
					null,
					2,
				)}\n`,
			);
		}

		const failed = Object.entries(results).filter(([, record]) => record.status === "failed");
		assert.deepEqual(
			failed.map(([key]) => key),
			[],
			`scenarios failed: ${failed.map(([key]) => key).join(", ")}`,
		);
	},
);