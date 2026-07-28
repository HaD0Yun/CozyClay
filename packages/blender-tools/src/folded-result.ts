import { Text } from "@earendil-works/pi-tui";

/**
 * Shared folded renderer for read-only inspection tools.
 *
 * The model-facing payload stays in `content`/`details` exactly as before;
 * this only changes what the terminal draws. Collapsed shows a few defensive
 * summary lines, expanded shows the model-facing text verbatim. A summarizer
 * returning no lines yields an empty fold rather than throwing on an
 * unexpected response shape.
 */
interface ToolResultLike {
	readonly content?: ReadonlyArray<{
		readonly type: string;
		readonly text?: string;
	}>;
}

interface RenderOptionsLike {
	readonly expanded?: boolean;
}

interface ThemeLike {
	fg(color: string, text: string): string;
}

interface RenderContextLike {
	readonly lastComponent?: unknown;
}

export function rawToolText(result: ToolResultLike): string {
	return result.content?.find((part) => part.type === "text")?.text ?? "";
}

export function renderFoldedResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike,
	context: RenderContextLike,
	lines: readonly string[],
	warning?: string,
): Text {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	if (options.expanded) {
		const raw = rawToolText(result);
		text.setText(raw ? `\n${theme.fg("toolOutput", raw)}` : "");
		return text;
	}
	let rendered = lines.length ? `\n${lines.map((line) => theme.fg("toolOutput", line)).join("\n")}` : "";
	if (warning) rendered += `\n${theme.fg("warning", warning)}`;
	text.setText(rendered);
	return text;
}

export function shortRevision(revision: unknown): string {
	return typeof revision === "string" && revision.length > 12 ? revision.slice(0, 12) : String(revision ?? "?");
}

export function formatVector(value: unknown): string {
	return Array.isArray(value) ? `[${value.map((component) => String(component)).join(", ")}]` : String(value ?? "?");
}
