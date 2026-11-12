const NODE_DOWNLOAD = "https://nodejs.org/en/download";
const OS_NAME = { mac: "macOS", win: "Windows", linux: "Linux" };

export function launchCommand(os) {
	return `${os === "win" ? "npx.cmd" : "npx"} --yes cozyclay@latest --via site`;
}

export function nodeInstaller(releases, os, winArch = "x64") {
	if (!Array.isArray(releases) || os === "linux" || (os === "win" && !winArch)) return NODE_DOWNLOAD;
	const platform = os === "mac" ? "osx-x64-pkg" : `win-${winArch}-msi`;
	const release = releases.find((entry) => {
		const version = /^v(\d+)\.(\d+)\.(\d+)$/.exec(entry?.version ?? "");
		return version && entry.lts && (+version[1] > 22 || (+version[1] === 22 && +version[2] >= 19))
			&& Array.isArray(entry.files) && entry.files.includes(platform);
	});
	if (!release) return NODE_DOWNLOAD;
	const suffix = os === "mac" ? ".pkg" : `-${winArch}.msi`;
	return `https://nodejs.org/dist/${release.version}/node-${release.version}${suffix}`;
}

export function setupInstall() {
	const install = document.getElementById("install");
	const platform = navigator.userAgentData?.platform || navigator.platform || "";
	const mobile = /iPhone|iPad|Android/i.test(navigator.userAgent) || (/Mac/.test(platform) && navigator.maxTouchPoints > 1);
	const detected = mobile ? null : /Mac/i.test(platform) ? "mac" : /Win/i.test(platform) ? "win" : /Linux|X11/i.test(platform) ? "linux" : null;
	let os = detected || "mac", releases = [], winArch = null, requested = false, copyRequest = 0;
	const nodeLink = document.getElementById("install-node");
	const copy = install.querySelector("[data-install-copy]");
	const status = document.getElementById("install-status");
	const command = document.getElementById("install-command");
	if (detected) document.querySelectorAll("[data-install-label]").forEach((label) => { label.textContent = `Install on ${OS_NAME[detected]}`; });

	const updateDownload = () => {
		nodeLink.href = nodeInstaller(releases, os, winArch);
		nodeLink.querySelector("span").textContent = os === "linux" ? "Get Node.js for Linux" : `Download Node.js for ${OS_NAME[os]}`;
	};
	const resetCopy = () => {
		copyRequest += 1;
		copy.disabled = false;
		copy.textContent = "Copy launch command";
		status.textContent = "Paste into your terminal and press Enter. The first launch may take a few minutes.";
		status.dataset.state = "";
	};
	const showOs = (nextOs) => {
		os = nextOs;
		install.dataset.os = os;
		install.querySelectorAll("[data-os]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.os === os)));
		install.querySelectorAll("[data-os-text]").forEach((node) => { node.textContent = node.dataset[os]; });
		command.textContent = launchCommand(os);
		copy.dataset.copy = launchCommand(os);
		document.querySelectorAll("[data-launch-command]").forEach((node) => { node.textContent = launchCommand(os); });
		document.querySelectorAll("[data-launch-copy]").forEach((button) => { button.dataset.copy = launchCommand(os); });
		updateDownload();
		resetCopy();
	};
	const showStep = (step, focus = true) => {
		install.querySelectorAll("[data-install-step]").forEach((panel) => { panel.hidden = panel.dataset.installStep !== String(step); });
		document.getElementById("install-progress").textContent = `Step ${step} of 2 · ${step === 1 ? "Install Node.js" : "Launch CozyClay"}`;
		resetCopy();
		if (focus) install.querySelector(`[data-install-step="${step}"] h3`).focus();
	};
	const loadInstallers = async () => {
		try {
			const response = await fetch("https://nodejs.org/dist/index.json", { signal: AbortSignal.timeout(5000) });
			if (response.ok) releases = await response.json();
		} catch { /* The official download page remains available offline or when CORS blocks the index. */ }
		updateDownload();
	};
	const detectWindowsArch = async () => {
		try {
			const hints = await navigator.userAgentData?.getHighEntropyValues?.(["architecture", "bitness"]);
			if (hints?.bitness === "64") winArch = hints.architecture === "arm" ? "arm64" : hints.architecture === "x86" ? "x64" : null;
			else if (/Win64|WOW64/i.test(navigator.userAgent)) winArch = "x64";
		} catch { /* Let the official download page choose when architecture is unavailable. */ }
		updateDownload();
	};
	const open = () => {
		if (install.open) return;
		showStep(1, false);
		install.showModal();
		if (!requested) {
			requested = true;
			void loadInstallers();
			void detectWindowsArch();
		}
	};
	showOs(os);
	install.querySelectorAll("[data-os]").forEach((button) => button.addEventListener("click", () => showOs(button.dataset.os)));
	install.querySelectorAll("[data-install-next]").forEach((button) => button.addEventListener("click", () => showStep(Number(button.dataset.installNext))));
	copy.addEventListener("click", async () => {
		const request = ++copyRequest;
		copy.disabled = true;
		try {
			await navigator.clipboard.writeText(launchCommand(os));
			if (request !== copyRequest) return;
			copy.textContent = "Copy again";
			status.textContent = "Copied. Paste into your terminal and press Enter.";
			status.dataset.state = "copied";
		} catch {
			if (request !== copyRequest) return;
			command.focus();
			const range = document.createRange();
			range.selectNodeContents(command);
			const selection = window.getSelection();
			selection.removeAllRanges();
			selection.addRange(range);
			status.textContent = "Copy was blocked. Select and copy the command above, then paste it into your terminal.";
			status.dataset.state = "error";
		} finally {
			if (request === copyRequest) copy.disabled = false;
		}
	});
	document.querySelectorAll("[data-install-open]").forEach((button) => button.addEventListener("click", open));
	const openFromHash = () => { if (location.hash === "#install") open(); };
	openFromHash();
	window.addEventListener("hashchange", openFromHash);
	install.querySelector("[data-install-close]").addEventListener("click", () => install.close());
	install.addEventListener("click", (event) => { if (event.target === install) install.close(); });
}
