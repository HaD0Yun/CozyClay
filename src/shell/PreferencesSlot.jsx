import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import SettingsMenu from "../settings-menu.jsx";
import { useStudioShell } from "./studio-shell-context.js";

// Temporary adapter until the Preferences region replaces SettingsMenu.
// SettingsMenu retains its trigger, focus and dismissal behavior.
// Mirror its published expanded state so future menus can also open it through
// the shell context, without mounting a second copy or changing SettingsMenu.
export default function PreferencesSlot() {
	const {
		preferencesOpen, setPreferencesOpen,
	} = useStudioShell();
	const hostRef = useRef(null);
	useEffect(() => {
		const trigger = hostRef.current.querySelector('[data-testid="settings-menu-trigger"]');
		const observer = new MutationObserver(() => {
			// Publish dismissal before another menu can request an open. A queued
			// mirror could otherwise overwrite that request (or make it a no-op).
			flushSync(() => setPreferencesOpen(trigger.getAttribute("aria-expanded") === "true"));
		});
		observer.observe(trigger, { attributes: true, attributeFilter: ["aria-expanded"] });
		return () => observer.disconnect();
	}, [setPreferencesOpen]);
	useEffect(() => {
		const trigger = hostRef.current.querySelector('[data-testid="settings-menu-trigger"]');
		if ((trigger.getAttribute("aria-expanded") === "true") !== preferencesOpen) trigger.click();
	}, [preferencesOpen]);
	return (
		<div className="preferences-slot" ref={hostRef}>
			<SettingsMenu />
		</div>
	);
}
