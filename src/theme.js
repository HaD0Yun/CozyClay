// Studio colour theme (#570). The choice lives on <html data-theme>, so the
// shell, its regions and body-level popovers all read the same token set.
export const THEMES = ["dark", "light"];
export const THEME_KEY = "cozyclay.theme.v1";
export const DEFAULT_THEME = "dark";

import { useEffect, useState } from "react";

/** The theme on <html data-theme>, following Preferences' live switch. */
export function useUiTheme() {
	const [theme, setTheme] = useState(() => globalThis.document?.documentElement.dataset.theme ?? readTheme());
	useEffect(() => {
		const onChange = (event) => setTheme(event.detail);
		globalThis.addEventListener("cozyclay:theme-change", onChange);
		return () => globalThis.removeEventListener("cozyclay:theme-change", onChange);
	}, []);
	return theme;
}

export function readTheme() {
	try {
		const stored = globalThis.localStorage?.getItem(THEME_KEY);
		return THEMES.includes(stored) ? stored : DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

export function applyTheme(theme) {
	const next = THEMES.includes(theme) ? theme : DEFAULT_THEME;
	document.documentElement.dataset.theme = next;
	return next;
}

export function saveTheme(theme) {
	const next = applyTheme(theme);
	try {
		globalThis.localStorage?.setItem(THEME_KEY, next);
	} catch (error) {
		console.warn("[cozyclay] theme not saved:", error?.name ?? error);
	}
	globalThis.dispatchEvent?.(new CustomEvent("cozyclay:theme-change", { detail: next }));
	return next;
}
