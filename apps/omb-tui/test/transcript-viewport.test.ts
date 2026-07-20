import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import type { DirectorTurnDelta, DirectorTurnEvent } from "@oh-my-blender/protocol";
import { TranscriptViewport, type MutableTranscriptComponent } from "../src/transcript-viewport.ts";

const TURN_ID = "22222222-2222-4222-8222-222222222222";
const SEGMENT_ID = "33333333-3333-4333-8333-333333333333";
const AT = "2026-07-20T00:00:00.000Z";

class SpyComponent implements MutableTranscriptComponent {
	text: string;
	setTextCount = 0;
	renderCount = 0;

	constructor(text: string) {
		this.text = text;
	}

	setText(text: string): void {
		this.text = text;
		this.setTextCount++;
	}

	render(width: number): string[] {
		this.renderCount++;
		const chunks: string[] = [];
		for (const sourceLine of this.text.split("\n")) {
			for (let offset = 0; offset < sourceLine.length; offset += width) {
				chunks.push(sourceLine.slice(offset, offset + width));
			}
			if (sourceLine.length === 0) chunks.push("");
		}
		return chunks;
	}

	invalidate(): void {}
}

function started(sequence: number, prompt = `prompt-${sequence}`): DirectorTurnEvent {
	return { type: "director_turn_started", id: TURN_ID, sequence, at: AT, prompt };
}

function delta(deltaSequence: number, text: string): DirectorTurnDelta {
	return {
		type: "director_turn_delta",
		id: TURN_ID,
		segment_id: SEGMENT_ID,
		content_index: 0,
		delta_sequence: deltaSequence,
		delta: text,
	};
}

function utterance(sequence: number, throughDeltaSequence: number, content: string): DirectorTurnEvent {
	return {
		type: "director_assistant_utterance",
		id: TURN_ID,
		sequence,
		at: AT,
		segment_id: SEGMENT_ID,
		content_index: 0,
		through_delta_sequence: throughDeltaSequence,
		content,
	};
}

function viewportFixture(height = 4, maxEntries = 10_000) {
	const markdown: SpyComponent[] = [];
	const text: SpyComponent[] = [];
	const viewport = new TranscriptViewport({
		getHeight: () => height,
		maxEntries,
		createMarkdown: (content) => {
			const component = new SpyComponent(content);
			markdown.push(component);
			return component;
		},
		createText: (content): Component => {
			const component = new SpyComponent(content);
			text.push(component);
			return component;
		},
	});
	return { viewport, markdown, text };
}

test("streaming mutates only one active Markdown component and seals it durably", () => {
	const { viewport, markdown } = viewportFixture();
	viewport.accept(started(0));
	viewport.accept(delta(0, "Hello"));
	viewport.render(80);
	assert.equal(markdown.length, 1);
	assert.equal(markdown[0]!.text, "Hello");

	viewport.accept(delta(1, " world"));
	viewport.render(80);
	assert.equal(markdown.length, 1, "a delta must not create or reparse durable utterance components");
	assert.equal(markdown[0]!.text, "Hello world");
	assert.equal(markdown[0]!.setTextCount, 2);

	viewport.accept(utterance(1, 1, "Hello world"));
	viewport.render(80);
	assert.equal(markdown.length, 2, "the seal creates exactly one immutable utterance Markdown component");
	assert.equal(markdown[1]!.text, "Hello world");
	assert.equal(viewport.activeSegment, undefined);
	assert.equal(viewport.retainedEventCount, 2);

	viewport.accept(utterance(1, 1, "Hello world"));
	assert.equal(markdown.length, 2, "durable event replay must be idempotent");
	assert.equal(viewport.retainedEventCount, 2);
});

test("tool and terminal boundaries discard unsealed live text", () => {
	const { viewport } = viewportFixture();
	viewport.accept(delta(0, "partial"));
	assert.notEqual(viewport.activeSegment, undefined);
	viewport.accept({
		type: "director_tool_call_started",
		id: TURN_ID,
		sequence: 1,
		at: AT,
		tool_call_id: "tool-1",
		tool_name: "inspect_project",
		params_summary: "{}",
	});
	assert.equal(viewport.activeSegment, undefined);
	viewport.accept(delta(0, "new partial"));
	viewport.accept({ type: "director_turn_cancelled", id: TURN_ID, sequence: 2, at: AT });
	assert.equal(viewport.activeSegment, undefined);
});

test("retention is bounded to durable entries plus one active component", () => {
	const { viewport, markdown } = viewportFixture(4, 3);
	for (let sequence = 0; sequence < 5; sequence++) viewport.accept(started(sequence));
	assert.equal(viewport.retainedEventCount, 3);
	viewport.accept(delta(0, "active"));
	assert.equal(viewport.retainedEventCount, 3);
	assert.equal(markdown.length, 1);
	assert.notEqual(viewport.activeSegment, undefined);
});

test("scroll anchor survives streaming append and width resize with a new-output indicator", () => {
	let height = 3;
	const { viewport } = viewportFixture(height, 100);
	for (let sequence = 0; sequence < 6; sequence++) viewport.accept(started(sequence, `anchor-${sequence}-long-content`));
	assert.match(viewport.render(12).join("\n"), /anchor-5/);

	viewport.scrollPage(-1);
	const before = viewport.render(12).join("\n");
	assert.match(before, /anchor-[0-4]/);
	assert.doesNotMatch(before, /New output below/);

	viewport.accept(started(6, "newest-output"));
	const appended = viewport.render(12).join("\n");
	assert.match(appended, /New output below/);
	assert.doesNotMatch(appended, /newest-output/);

	height = 5;
	const resized = viewport.render(20).join("\n");
	assert.match(resized, /anchor-[0-4]/, "resize must preserve the anchored durable entry");
	assert.match(resized, /New output below/);

	viewport.scrollPage(1);
	viewport.scrollPage(1);
	assert.match(viewport.render(20).join("\n"), /newest-output/);
	assert.equal(viewport.hasNewOutput, false);
});

test("replace discards ephemeral state and reconstructs only durable utterances", () => {
	const { viewport, markdown } = viewportFixture();
	viewport.accept(delta(0, "must disappear"));
	viewport.replace([started(0), utterance(1, -1, "durable replay")]);
	assert.equal(viewport.activeSegment, undefined);
	assert.equal(viewport.retainedEventCount, 2);
	assert.equal(markdown.at(-1)?.text, "durable replay");
	assert.doesNotMatch(viewport.render(80).join("\n"), /must disappear/);
});
