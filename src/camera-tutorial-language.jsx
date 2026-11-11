// The first thing a first hosted visit sees (guest-start-mount.jsx): which language the Studio and its tutorial
// speak. It is asked before the guest project is made, because a language change reloads the page (locale.js) and
// a reload after the project exists would resume it without the tutorial. Someone who chose a language before is
// not asked again.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LOCALE, keepLocale, setLocale } from "./locale.js";
import "./camera-tutorial.css";

const LANGUAGES = [{ id: "en", label: "English" }, { id: "ko", label: "한국어" }, { id: "zh", label: "简体中文" }];
// every reader has to find their own word, so the heading is in all three
const HEADING = Object.values({ en: "Language", ko: "언어", zh: "语言" }).join(" · ");

/** The viewport pane the tutorial hangs in; null until the shell has mounted it. */
export function useViewportHost() {
	const [host, setHost] = useState(() => document.querySelector(".viewport"));
	useEffect(() => {
		if (host) return undefined;
		const frame = requestAnimationFrame(() => setHost(document.querySelector(".viewport")));
		return () => cancelAnimationFrame(frame);
	}, [host]);
	return host;
}

/** onChosen runs when the visitor keeps the language the page is in; another one saves the choice and reloads. */
export default function TutorialLanguage({ onChosen }) {
	const host = useViewportHost();
	if (!host) return null;
	return createPortal(
		<aside className="camera-tutorial camera-tutorial-language" data-testid="camera-tutorial-language" aria-label="Language">
			<div className="camera-tutorial-card">
				<span className="camera-tutorial-count">{HEADING}</span>
			</div>
			<div className="camera-tutorial-languages">
				{LANGUAGES.map((language) => (
					<button key={language.id} type="button" data-locale={language.id} aria-pressed={LOCALE === language.id}
						onClick={() => { if (language.id === LOCALE) { keepLocale(); onChosen?.(); } else setLocale(language.id); }}>
						{language.label}
					</button>
				))}
			</div>
		</aside>,
		host,
	);
}
