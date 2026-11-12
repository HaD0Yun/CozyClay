import { randomUUID as nodeRandomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const POSTHOG_PROJECT_TOKEN = "phc_CpizzZ8VhSorSS8yEeQhdpUcvB2erp5xkCbnFD8HTJ5m";
const POSTHOG_API_HOST = "https://t.cozyclay.org";
// First-launch answers plus the `npx cozyclay --via <source>` values the
// landing page's copy commands carry (#466). Mirrors analytics HEARD_FROM_SOURCES.
export const FIRST_LAUNCH_SOURCES = Object.freeze(["x", "hn", "reddit", "github", "friend", "other", "site", "playground", "installer"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rawState(stateFile) {
	try {
		const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (error) {
		// A corrupt file is not an opt-out: fall back to defaults (telemetry on)
		// rather than silently disabling collection forever.
		return {};
	}
}

function normalizedState(value) {
	return {
		installationId: typeof value.installationId === "string" && UUID_PATTERN.test(value.installationId)
			? value.installationId
			: null,
		telemetryEnabled: value.telemetryEnabled !== false,
		internalQa: value.internalQa === true,
		firstLaunchedAt: typeof value.telemetryFirstLaunchedAt === "string"
			? value.telemetryFirstLaunchedAt
			: null,
		noticeVersion: Number.isInteger(value.telemetryNoticeVersion)
			? value.telemetryNoticeVersion
			: 0,
		firstLaunchHeardFrom: FIRST_LAUNCH_SOURCES.includes(value.telemetryFirstLaunchHeardFrom)
			? value.telemetryFirstLaunchHeardFrom
			: null,
	};
}

function writeState(stateFile, patch) {
	const next = { ...rawState(stateFile), ...patch };
	if (typeof next.internalQa !== "boolean") next.internalQa = false;
	mkdirSync(dirname(stateFile), { recursive: true });
	const temporary = `${stateFile}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(next, null, "\t"), { mode: 0o600 });
	renameSync(temporary, stateFile);
}

function envDisablesTelemetry(env) {
	// Only explicit opt-outs count. CI heuristics silently disabled telemetry
	// in devcontainers and Docker images that set CI=true by accident.
	if (/^(1|true|yes|on)$/i.test(env.DO_NOT_TRACK ?? "")) return true;
	return /^(0|false|no|off)$/i.test(env.COZYCLAY_TELEMETRY ?? "");
}

export function readTelemetryState(stateFile) {
	return normalizedState(rawState(stateFile));
}

export function effectiveTelemetryEnabled(state, env = process.env) {
	return state.telemetryEnabled && !envDisablesTelemetry(env);
}

export function setTelemetryInternalQa(stateFile, enabled) {
	writeState(stateFile, { internalQa: enabled === true });
	return readTelemetryState(stateFile);
}

export function setTelemetryEnabled(stateFile, enabled) {
	writeState(stateFile, {
		telemetryEnabled: enabled === true,
		...(enabled === true ? {} : { installationId: null }),
	});
	return readTelemetryState(stateFile);
}

export function markTelemetryFirstLaunch(stateFile, now = () => new Date().toISOString()) {
	if (readTelemetryState(stateFile).firstLaunchedAt) return;
	writeState(stateFile, { telemetryFirstLaunchedAt: now() });
}

export function setTelemetryFirstLaunchSource(stateFile, heardFrom) {
	if (!FIRST_LAUNCH_SOURCES.includes(heardFrom)) return readTelemetryState(stateFile);
	writeState(stateFile, { telemetryFirstLaunchHeardFrom: heardFrom });
	return readTelemetryState(stateFile);
}

export function takeRuntimeTelemetryConfig(
	stateFile,
	{
		appVersion,
		officialPackage = true,
		installKind = null,
		env = process.env,
		randomUUID = nodeRandomUUID,
	} = {},
) {
	const existing = readTelemetryState(stateFile);
	const telemetryEnabled = officialPackage && effectiveTelemetryEnabled(existing, env);
	const internalQa = telemetryEnabled && existing.internalQa;
	let installationId = existing.installationId;
	const firstLaunch = telemetryEnabled && !existing.firstLaunchedAt;
	const patch = {};

	if (telemetryEnabled && !installationId) {
		installationId = randomUUID();
		patch.installationId = installationId;
	}
	if (Object.keys(patch).length > 0) writeState(stateFile, patch);

	return {
		distribution: "npm",
		telemetryEnabled,
		internalQa,
		installationId: telemetryEnabled ? installationId : null,
		appVersion,
		apiKey: POSTHOG_PROJECT_TOKEN,
		apiHost: POSTHOG_API_HOST,
		firstLaunch,
		firstLaunchHeardFrom: existing.firstLaunchHeardFrom,
		installKind: ["npx", "global", "clone"].includes(installKind)
			? installKind
			: env.npm_config_global === "true" || env.npm_config_global === true ? "global" : "npx",
	};
}
