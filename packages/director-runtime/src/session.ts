import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type ApplyCameraPlanBridge,
	createApplyCameraPlanTool,
	createInspectProjectTool,
	type InspectProjectBridge,
} from "@oh-my-blender/blender-tools";
import { BundledDirectorResourceLoader, DIRECTOR_PROMPT_DIGEST } from "./resource-loader.ts";

export const DIRECTOR_TOOL_ALLOWLIST = ["inspect_project", "apply_camera_plan"] as const;

export interface DirectorSessionOptions {
	readonly bridge: InspectProjectBridge & Partial<ApplyCameraPlanBridge>;
	readonly model: Model<string>;
	readonly modelRuntime: ModelRuntime;
	readonly cwd?: string;
	readonly agentDir?: string;
}

export async function createDirectorSession(options: DirectorSessionOptions) {
	const cwd = options.cwd ?? process.cwd();
	const ownsAgentDir = options.agentDir === undefined;
	const agentDir = options.agentDir ?? mkdtempSync(join(tmpdir(), "omb-director-agent-"));
	const resourceLoader = new BundledDirectorResourceLoader();
	const mutationBridge =
		options.bridge.applyCameraPlan === undefined
			? undefined
			: { applyCameraPlan: options.bridge.applyCameraPlan.bind(options.bridge) };
	const enabledTools =
		mutationBridge === undefined ? DIRECTOR_TOOL_ALLOWLIST.slice(0, 1) : [...DIRECTOR_TOOL_ALLOWLIST];
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: options.model,
		modelRuntime: options.modelRuntime,
		thinkingLevel: "off",
		resourceLoader,
		customTools:
			mutationBridge === undefined
				? [createInspectProjectTool(options.bridge)]
				: [createInspectProjectTool(options.bridge), createApplyCameraPlanTool(mutationBridge)],
		tools: enabledTools,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	});

	const effectiveTools = session.getActiveToolNames();
	if (
		effectiveTools.length !== enabledTools.length ||
		effectiveTools.some((name, index) => name !== enabledTools[index])
	) {
		session.dispose();
		throw new Error(`DIRECTOR_TOOL_ALLOWLIST_MISMATCH: ${effectiveTools.join(",")}`);
	}
	if (resourceLoader.promptDigest() !== DIRECTOR_PROMPT_DIGEST) {
		session.dispose();
		throw new Error("DIRECTOR_PROMPT_DIGEST_MISMATCH");
	}

	const dispose = session.dispose.bind(session);
	session.dispose = () => {
		try {
			dispose();
		} finally {
			if (ownsAgentDir) rmSync(agentDir, { recursive: true, force: true });
		}
	};

	return session;
}
