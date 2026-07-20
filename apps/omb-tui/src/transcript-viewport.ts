import {
	Markdown,
	Text,
	type Component,
	type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { DirectorTurnDelta, DirectorTurnEvent } from "@oh-my-blender/protocol";

const identity = (text: string) => text;

export const OMB_MARKDOWN_THEME: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

export interface MutableTranscriptComponent extends Component {
	setText(text: string): void;
}

export interface TranscriptViewportOptions {
	readonly getHeight: () => number;
	readonly maxEntries?: number;
	readonly createMarkdown?: (text: string) => MutableTranscriptComponent;
	readonly createText?: (text: string) => Component;
}

interface TranscriptEntry {
	readonly key: string;
	readonly component: Component;
}

interface ActiveSegment {
	readonly key: string;
	readonly turnId: string;
	readonly segmentId: string;
	readonly contentIndex: number;
	component: MutableTranscriptComponent;
	content: string;
	nextSequence: number;
}

interface Anchor {
	readonly key: string;
	readonly offset: number;
}

interface RenderedLine {
	readonly key: string;
	readonly offset: number;
	readonly text: string;
}

function eventKey(event: DirectorTurnEvent): string {
	return `${event.id}:${event.sequence}`;
}

function segmentKey(message: Pick<DirectorTurnDelta, "id" | "segment_id" | "content_index">): string {
	return `${message.id}:${message.segment_id}:${message.content_index}`;
}

function eventText(event: Exclude<DirectorTurnEvent, { type: "director_assistant_utterance" }>): string {
	switch (event.type) {
		case "director_turn_started":
			return `> ${event.prompt}`;
		case "director_tool_call_started":
			return `[${event.tool_name}] started ${event.params_summary}`;
		case "director_tool_call_finished":
			return `[${event.tool_name}] ${event.is_error ? "failed" : "finished"} ${event.result_digest}`;
		case "director_turn_completed":
			return event.summary;
		case "director_turn_failed":
			return `${event.code}: ${event.message}`;
		case "director_turn_cancelled":
			return "Turn cancelled.";
	}
}

export class TranscriptViewport implements Component {
	private readonly getHeight: () => number;
	private readonly maxEntries: number;
	private readonly createMarkdown: (text: string) => MutableTranscriptComponent;
	private readonly createText: (text: string) => Component;
	private readonly entries: TranscriptEntry[] = [];
	private readonly eventKeys = new Set<string>();
	private active: ActiveSegment | undefined;
	private noticeSequence = 0;
	private followingOutput = true;
	private newOutput = false;
	private anchor: Anchor | undefined;
	private lastLines: RenderedLine[] = [];
	private lastTop = 0;

	constructor(options: TranscriptViewportOptions) {
		this.getHeight = options.getHeight;
		this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 10_000));
		this.createMarkdown = options.createMarkdown ?? ((text) => new Markdown(text, 1, 0, OMB_MARKDOWN_THEME));
		this.createText = options.createText ?? ((text) => new Text(text, 1, 0));
	}

	get retainedEventCount(): number {
		return this.entries.length;
	}

	get activeSegment(): string | undefined {
		return this.active?.key;
	}

	get hasNewOutput(): boolean {
		return this.newOutput;
	}

	accept(message: DirectorTurnDelta | DirectorTurnEvent): void {
		if (message.type === "director_turn_delta") {
			this.acceptDelta(message);
			return;
		}
		this.acceptEvent(message);
	}

	replace(events: readonly DirectorTurnEvent[]): void {
		this.entries.length = 0;
		this.eventKeys.clear();
		this.active = undefined;
		this.followingOutput = true;
		this.newOutput = false;
		this.anchor = undefined;
		for (const event of events) this.acceptEvent(event);
	}

	appendNotice(notice: string): void {
		const normalized = notice.trim();
		if (normalized.length === 0) return;
		this.appendEntry({
			key: `notice:${this.noticeSequence++}`,
			component: this.createText(normalized),
		});
	}

	discardEphemeral(): void {
		this.active = undefined;
	}

	scrollPage(direction: -1 | 1): void {
		const height = Math.max(1, Math.floor(this.getHeight()));
		const page = Math.max(1, height - 1);
		const bottom = Math.max(0, this.lastLines.length - height);
		const currentTop = this.followingOutput ? bottom : this.anchorIndex();
		const nextTop = Math.max(0, Math.min(bottom, currentTop + direction * page));
		if (direction > 0 && nextTop >= bottom) {
			this.followingOutput = true;
			this.newOutput = false;
			this.anchor = undefined;
			return;
		}
		this.followingOutput = false;
		const line = this.lastLines[nextTop];
		this.anchor = line === undefined ? undefined : { key: line.key, offset: line.offset };
	}

	invalidate(): void {
		for (const entry of this.entries) entry.component.invalidate();
		this.active?.component.invalidate();
		this.lastLines = [];
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const height = Math.max(1, Math.floor(this.getHeight()));
		const lines = this.renderLines(safeWidth);
		this.lastLines = lines;
		const indicatorLines = !this.followingOutput && this.newOutput ? 1 : 0;
		const contentHeight = Math.max(0, height - indicatorLines);
		const bottom = Math.max(0, lines.length - contentHeight);
		const top = this.followingOutput ? bottom : Math.min(this.anchorIndex(), bottom);
		this.lastTop = top;
		const visible = lines.slice(top, top + contentHeight).map((line) => line.text);
		while (visible.length < contentHeight) visible.push(" ".repeat(safeWidth));
		if (indicatorLines === 1) visible.push("New output below".padEnd(safeWidth));
		return visible;
	}

	private acceptDelta(message: DirectorTurnDelta): void {
		const key = segmentKey(message);
		if (this.active?.key !== key) {
			this.active = undefined;
			if (message.delta_sequence !== 0) return;
			this.active = {
				key,
				turnId: message.id,
				segmentId: message.segment_id,
				contentIndex: message.content_index,
				component: this.createMarkdown(""),
				content: "",
				nextSequence: 0,
			};
		}
		if (message.delta_sequence < this.active.nextSequence) return;
		if (message.delta_sequence !== this.active.nextSequence) {
			this.active = undefined;
			return;
		}
		this.active.content += message.delta;
		this.active.nextSequence++;
		this.active.component.setText(this.active.content);
		this.markOutput();
	}

	private acceptEvent(event: DirectorTurnEvent): void {
		const key = eventKey(event);
		if (this.eventKeys.has(key)) return;
		if (event.type === "director_assistant_utterance") {
			if (
				this.active?.key === segmentKey(event) &&
				event.through_delta_sequence >= this.active.nextSequence - 1
			) {
				this.active = undefined;
			}
			this.eventKeys.add(key);
			this.appendEntry({ key, component: this.createMarkdown(event.content) });
			return;
		}
		if (
			event.type === "director_tool_call_started" ||
			event.type === "director_tool_call_finished" ||
			event.type === "director_turn_completed" ||
			event.type === "director_turn_failed" ||
			event.type === "director_turn_cancelled"
		) {
			this.active = undefined;
		}
		this.eventKeys.add(key);
		this.appendEntry({ key, component: this.createText(eventText(event)) });
	}

	private appendEntry(entry: TranscriptEntry): void {
		this.entries.push(entry);
		while (this.entries.length > this.maxEntries) {
			const removed = this.entries.shift();
			if (removed === undefined) break;
			this.eventKeys.delete(removed.key);
			if (this.anchor?.key === removed.key) {
				this.anchor = this.entries[0] === undefined ? undefined : { key: this.entries[0].key, offset: 0 };
			}
		}
		this.markOutput();
	}

	private markOutput(): void {
		if (!this.followingOutput) this.newOutput = true;
	}

	private renderLines(width: number): RenderedLine[] {
		const lines: RenderedLine[] = [];
		for (const entry of this.entries) {
			const rendered = entry.component.render(width);
			for (let offset = 0; offset < rendered.length; offset++) {
				lines.push({ key: entry.key, offset, text: rendered[offset] ?? "" });
			}
		}
		if (this.active !== undefined) {
			const rendered = this.active.component.render(width);
			for (let offset = 0; offset < rendered.length; offset++) {
				lines.push({ key: this.active.key, offset, text: rendered[offset] ?? "" });
			}
		}
		return lines;
	}

	private anchorIndex(): number {
		if (this.anchor === undefined) return this.lastTop;
		const exact = this.lastLines.findIndex(
			(line) => line.key === this.anchor!.key && line.offset === this.anchor!.offset,
		);
		if (exact !== -1) return exact;
		const entry = this.lastLines.findIndex((line) => line.key === this.anchor!.key);
		return entry === -1 ? this.lastTop : entry;
	}
}
