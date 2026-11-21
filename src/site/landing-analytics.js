// Landing page (index.html) analytics: one $pageview and landing:cta_clicked.
// Same hosted consent rules as /app/ (no cookies, DNT respected, no autocapture);
// the lite init skips session, error, long-task and device signals.
import { initAnalytics, track } from "../analytics.js";
import { LANDING_CTA_TARGETS } from "../analytics-strict.js";

// the launch command ends in --via site, or --via playground when the page was opened from the Studio (src/install.js)
const COPY_TARGETS = [["cozyclay@latest --via ", "copy_npx"], ["git clone", "copy_clone"], ["mcpServers", "copy_mcp"], ["cclay live", "copy_terminal"]];

/** The landing:cta_clicked target for a clicked element, or null when it is not a call to action. */
export function ctaTarget(element) {
	if (element.closest?.("[data-install-open]")) return "install_open";
	if (element.closest?.("a[data-node-download]")) return "node_download";
	if (element.closest?.("a[data-installer-download]")) return "installer_download";
	const copy = element.closest?.("button.copy[data-copy]");
	if (copy) return COPY_TARGETS.find(([needle]) => copy.dataset.copy.includes(needle))?.[1] ?? null;
	const href = element.closest?.("a[href]")?.getAttribute("href") ?? "";
	if (href === "/app/" || href.startsWith("/app/?")) return "app";
	if (href.includes("INSTALL_FOR_AGENTS")) return "agent_install_doc";
	if (href.startsWith("https://github.com/HaD0Yun/CozyClay")) return "github";
	if (href.startsWith("https://discord.gg/")) return "discord";
	if (href.startsWith("https://www.npmjs.com/package/cozyclay")) return "npm";
	return null;
}

if (typeof document !== "undefined") {
	void initAnalytics({ lite: true });
	document.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? ctaTarget(event.target) : null;
		if (target && LANDING_CTA_TARGETS.includes(target)) track("landing:cta_clicked", { target });
	}, { capture: true });
}
