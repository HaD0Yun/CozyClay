// CozyClay UI locale. English is the default; Korean and Chinese are opt-in.
//
// An explicit choice saved in localStorage wins. Without one, the UI always
// starts in English regardless of browser or operating-system language.
// The locale is fixed for the lifetime of the page — every label goes through
// ko() at render time, so switching saves the choice and reloads.
//
// Chinese lives in a central dictionary (locale-zh.js) keyed by the English
// default, so the ~1500 call sites stay unchanged upstream. A third argument
// overrides the dictionary where one English string needs two translations.
import { ZH } from "./locale-zh.js";

const KEY = "cozyclay.locale";
const LOCALES = new Set(["en", "ko", "zh"]);

function stored() {
	try {
		const value = localStorage.getItem(KEY);
		return LOCALES.has(value) ? value : null;
	} catch {
		return null;
	}
}

export const LOCALE = stored() ?? "en";
export const isKo = LOCALE === "ko";
export const isZh = LOCALE === "zh";
// Whether the operator has ever picked a language. A Korean browser that has
// not chosen yet still gets the English default, so the Settings trigger wears
// "한국어" as its first-run cue until a choice is stored (#193).
export const localeChosen = stored() !== null;

/** Pick the label for the active locale: ko("Frame", "프레임", "帧"). */
export function ko(en, koText, zhText) {
	if (isKo) return koText;
	if (isZh) return zhText ?? ZH[en] ?? en;
	return en;
}

/** Save the language the page is already in as the visitor's choice. Nothing changes on screen, so no reload. */
export function keepLocale() {
	try {
		localStorage.setItem(KEY, LOCALE);
	} catch {
		// Private mode without storage: the page stays in this language for this load.
	}
}

export function setLocale(next) {
	if (!LOCALES.has(next)) return;
	try {
		localStorage.setItem(KEY, next);
	} catch {
		// Private mode without storage: the toggle still works for this load.
	}
	window.location.reload();
}
