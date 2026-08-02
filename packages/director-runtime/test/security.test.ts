import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type BundledDirectorResourceLoader, DIRECTOR_PROMPT } from "../src/resource-loader.ts";
import { createDirectorSession, DIRECTOR_TOOL_ALLOWLIST } from "../src/session.ts";

async function seedHostileResources(root: string, suffix = "startup") {
	const files: Record<string, string> = {
		[`.pi/extensions/hostile-${suffix}.ts`]: "throw new Error('HOSTILE_EXTENSION_EXECUTED')",
		[`.pi/skills/hostile-${suffix}/SKILL.md`]: "# hostile skill",
		[`.pi/prompts/hostile-${suffix}.md`]: "hostile prompt",
		[`.pi/themes/hostile-${suffix}.json`]: "{}",
		"AGENTS.md": "hostile context",
		"package.json": JSON.stringify({ pi: { extensions: ["./hostile.ts"] } }),
		[`.pi/mcp-${suffix}.json`]: JSON.stringify({ mcpServers: { hostile: {} } }),
	};
	for (const [relative, content] of Object.entries(files)) {
		const path = join(root, relative);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, content);
	}
}

function assertBundleOnly(loader: BundledDirectorResourceLoader) {
	assert.equal(loader.getSystemPrompt(), DIRECTOR_PROMPT);
	assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
	assert.deepEqual(loader.getPrompts(), { prompts: [], diagnostics: [] });
	assert.deepEqual(loader.getThemes(), { themes: [], diagnostics: [] });
	assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
	assert.deepEqual(loader.getAppendSystemPrompt(), []);
	assert.deepEqual(loader.getExtensions().extensions, []);
	assert.deepEqual(loader.getExtensions().errors, []);
}

describe("director prompt", () => {
	it("limits stage_scene guidance to retained operations and keeps ordinary work in Blender Python", () => {
		assert.match(DIRECTOR_PROMPT, /execute_blender_python/);
		assert.match(
			DIRECTOR_PROMPT,
			/stage_scene is only for add_character, adopt_entity, set_render_settings, and apply_motion/,
		);
		for (const deletedOperation of ["add_primitive", "add_camera", "transform_entity", "create_assembly"]) {
			assert.doesNotMatch(DIRECTOR_PROMPT, new RegExp(deletedOperation));
		}
	});
	it("documents camera evidence and ARDY's queued typed boundary", () => {
		assert.match(DIRECTOR_PROMPT, /apply_camera_plan/);
		assert.match(DIRECTOR_PROMPT, /evidence_sha256 from produce_directing_evidence/);
		assert.match(DIRECTOR_PROMPT, /ardy_regenerate only to constrain an existing base motion/);
		assert.match(DIRECTOR_PROMPT, /ardy_generate for unconstrained first-pass text-to-motion generation/);
		assert.match(DIRECTOR_PROMPT, /ardy_inbetween for pose-captured in-between synthesis/);
		assert.doesNotMatch(DIRECTOR_PROMPT, /is not exposed as a director tool/);
		assert.match(DIRECTOR_PROMPT, /Do not present raw Python as a trusted ARDY path/);
		assert.match(DIRECTOR_PROMPT, /correctness boundaries for well-behaved callers only, never security isolation/);
	});
});
describe("hostile local resource isolation", () => {
	const unregister: Array<() => void> = [];
	const cleanup: string[] = [];
	afterEach(async () => {
		while (unregister.length > 0) unregister.pop()?.();
		await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	});

	it("keeps startup, reload, extension, replacement, and disposal bundle-only", async () => {
		const root = await mkdtemp(join(tmpdir(), "cclay-hostile-"));
		cleanup.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		await Promise.all([seedHostileResources(agentDir), seedHostileResources(projectDir)]);

		const faux = registerFauxProvider();
		unregister.push(faux.unregister);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: faux.api, models: faux.models });
		const bridge = {
			inspectProject: async () => {
				throw new Error("not invoked");
			},
			inspectBridgeState: () => ({ attached: false }),
			inspectPerformance: async () => {
				throw new Error("not invoked");
			},
			inspectEntity: async () => {
				throw new Error("not invoked");
			},
			inspectPoseContacts: async () => {
				throw new Error("not invoked");
			},
			inspectRelations: async () => {
				throw new Error("not invoked");
			},
			preflightMotion: async () => {
				throw new Error("not invoked");
			},
			captureViewport: async () => {
				throw new Error("not invoked");
			},
			produceDirectingEvidence: async () => {
				throw new Error("not invoked");
			},
			inspectVisualQaMetrics: async () => {
				throw new Error("not invoked");
			},
			applyCameraPlan: async () => {
				throw new Error("not invoked");
			},
			stageScene: async () => {
				throw new Error("not invoked");
			},
			renderQaFrames: async () => {
				throw new Error("not invoked");
			},
			repairBridge: () => ({ repaired: true }),
			applyPerformanceMode: async () => {
				throw new Error("not invoked");
			},
			createFallMotion: async () => {
				throw new Error("not invoked");
			},
			replaceCameraAction: async () => {
				throw new Error("not invoked");
			},
			regenerate: async () => {
				throw new Error("not invoked");
			},
			generate: async () => {
				throw new Error("not invoked");
			},
			inbetween: async () => {
				throw new Error("not invoked");
			},
			executeBlenderPython: async () => {
				throw new Error("not invoked");
			},
		};

		const first = await createDirectorSession({ bridge, model, modelRuntime, cwd: projectDir, agentDir });
		const firstLoader = first.resourceLoader as BundledDirectorResourceLoader;
		try {
			assert.deepEqual(first.getActiveToolNames(), [...DIRECTOR_TOOL_ALLOWLIST]);
			assertBundleOnly(firstLoader);

			await Promise.all([seedHostileResources(agentDir, "reload"), seedHostileResources(projectDir, "reload")]);
			await first.reload();
			assert.deepEqual(first.getActiveToolNames(), [...DIRECTOR_TOOL_ALLOWLIST]);
			assertBundleOnly(firstLoader);

			assert.throws(
				() =>
					firstLoader.extendResources({
						skillPaths: [{ path: join(projectDir, ".pi/skills"), metadata: {} as never }],
					}),
				/RESOURCE_EXTENSION_DENIED/,
			);
			assertBundleOnly(firstLoader);
			firstLoader.extendResources({});

			const second = await createDirectorSession({ bridge, model, modelRuntime, cwd: projectDir, agentDir });
			try {
				const secondLoader = second.resourceLoader as BundledDirectorResourceLoader;
				assert.notEqual(secondLoader, firstLoader);
				assert.deepEqual(second.getActiveToolNames(), [...DIRECTOR_TOOL_ALLOWLIST]);
				assertBundleOnly(secondLoader);
				first.dispose();
				assert.deepEqual(second.getActiveToolNames(), [...DIRECTOR_TOOL_ALLOWLIST]);
				assertBundleOnly(secondLoader);
			} finally {
				second.dispose();
			}
		} finally {
			first.dispose();
		}
	});
});
