/**
 * OMB terminal theme: raw-ANSI style functions (zero dependencies).
 *
 * Every style is a `(text) => string` so it can plug directly into pi-tui's
 * EditorTheme / MarkdownTheme slots. Styles wrap the text without inserting
 * escape codes inside it, so substring assertions on plain content keep
 * working. `NO_COLOR` (or a non-TTY stdout) disables all styling.
 */

export type Style = (text: string) => string;

export interface OmbTheme {
	readonly accent: Style;
	readonly ok: Style;
	readonly err: Style;
	readonly warn: Style;
	readonly muted: Style;
	readonly code: Style;
	readonly bold: Style;
	readonly italic: Style;
	readonly underline: Style;
}

function wrap(enabled: boolean, open: string, close: string): Style {
	if (!enabled) return (text) => text;
	return (text) => `\u001b[${open}m${text}\u001b[${close}m`;
}

export function createTheme(enabled: boolean): OmbTheme {
	return {
		accent: wrap(enabled, "38;5;208", "39"),
		ok: wrap(enabled, "38;5;114", "39"),
		err: wrap(enabled, "38;5;203", "39"),
		warn: wrap(enabled, "38;5;214", "39"),
		muted: wrap(enabled, "38;5;245", "39"),
		code: wrap(enabled, "38;5;179", "39"),
		bold: wrap(enabled, "1", "22"),
		italic: wrap(enabled, "3", "23"),
		underline: wrap(enabled, "4", "24"),
	};
}

function colorsEnabled(): boolean {
	if (process.env.NO_COLOR !== undefined) return false;
	if (process.env.OMB_NO_COLOR !== undefined) return false;
	return true;
}

export const theme: OmbTheme = createTheme(colorsEnabled());
