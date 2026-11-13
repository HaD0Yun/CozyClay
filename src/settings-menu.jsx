import { useCallback, useRef, useState } from "react";
import { ko, localeChosen } from "./locale.js";
import PreferencesDialog from "./shell/PreferencesDialog.jsx";

// App settings — language — behind one labelled topbar trigger
// (#193, docs/studio-ui-ia.md R4). Neither item edits the document, so they do
// not belong on the Save/Export row as bare toggles.
//
// The trigger opens the v2 Preferences dialog, whose LanguageControls
// (shell/preference-controls.jsx) hold the language choices.

export default function SettingsMenu() {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef(null);
	const close = useCallback(() => {
		setOpen(false);
		triggerRef.current?.focus();
	}, []);

	// First-run cue: the studio starts in English even on a Korean browser, so
	// the only visible hint that Korean exists used to be the old locale button.
	// Until a language is stored, a ko-* browser sees the trigger in Korean.
	const koreanBrowser = typeof navigator !== "undefined" && (navigator.language ?? "").startsWith("ko");
	const chineseBrowser = typeof navigator !== "undefined" && (navigator.language ?? "").startsWith("zh");
	const firstRunCue = koreanBrowser ? "한국어" : chineseBrowser ? "简体中文" : null;
	const label = !localeChosen && firstRunCue ? firstRunCue : ko("Settings", "설정", "设置");

	return (
		<div className="settings-menu-wrap">
			<button
				type="button"
				className="topbar-action settings-menu-trigger"
				data-testid="settings-menu-trigger"
				aria-expanded={open}
				aria-haspopup="dialog"
				title={ko("Language settings", "언어 설정", "语言设置")}
				ref={triggerRef}
				onClick={() => (open ? close() : setOpen(true))}
			>
				{label}
				<span className="caret">▾</span>
			</button>
			<PreferencesDialog
				open={open}
				onClose={close}
				initialSection="Appearance"
			/>
		</div>
	);
}
