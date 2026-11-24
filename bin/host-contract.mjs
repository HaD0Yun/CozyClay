// The contract between the launcher and a host app that starts it and shows the
// Studio in its own window (the desktop app does both, #1319). A host runs
// `npx cozyclay@latest`, so every release reaches every installed host at once:
// each promise below must hold for hosts that already shipped.
//
// - Launch flags: --no-open, --no-star, --no-update-check, --via <v> and
//   --port <n> stay accepted (parseArgs in bin/cozyclay.mjs).
// - Ready: with COZYCLAY_DESKTOP=1 the launcher prints one JSON line,
//   {"cozyclay":"ready","url":...,"version":...,"contract":1,"capabilities":[...]},
//   before the human "CozyClay is running at <url>" line, which stays word for
//   word. A Studio whose human line comes with no JSON line before it predates
//   the contract: treat it as contract 0.
// - GET /__cozyclay/contract answers {contract, version, capabilities}
//   (bin/studio-routes.mjs); a Studio before the contract answers 404.
// - HOST_CONTRACT_VERSION changes only when a change to an agent route a host
//   reads would break a host that is already installed: GET /agent/providers,
//   /agent/models, /agent/sessions, /agent/video/providers and POST /agent/video.
//   A new field is not a break. test/verify-host-contract.mjs pins the version
//   with the fields hosts read.
// - HOST_CAPABILITIES names optional features a host may use. "project-files":
//   the Studio opens and saves projects through window.cozyclayHost.projectFiles
//   when the host provides it (src/host-project-files.js). "agent-brief": the
//   host hands the Studio's own agent one message with pictures through
//   window.cozyclayHost.agentBrief and is told how that turn ended
//   (src/host-agent-brief.js). A new capability is not a break: a host that
//   does not know a name ignores it.
export const HOST_CONTRACT_VERSION = 1;
export const HOST_CAPABILITIES = Object.freeze(["project-files", "agent-brief"]);

export function hostContract(version) {
	return { contract: HOST_CONTRACT_VERSION, version, capabilities: [...HOST_CAPABILITIES] };
}

// What the launcher prints once it listens: the JSON line first when a host
// asked for it, so a host that sees the human line alone knows the contract is
// missing, then the human lines.
export function announceReady(url, version, { env = process.env, log = console.log } = {}) {
	if (env.COZYCLAY_DESKTOP === "1") log(JSON.stringify({ cozyclay: "ready", url, ...hostContract(version) }));
	log(`CozyClay is running at ${url}`);
	log("Use a Chromium-based browser — Safari and Firefox are not supported.");
}
