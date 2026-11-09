// The v4 tools of one conversation: the track store first, then the tools, then js with the others as host functions.
import { rigFacts } from "../../../src/motion-v4/rig/facts.js";
import { createTrackStore } from "../../../src/motion-v4/track/store.js";
import { createJsTool } from "./js-tool.mjs";
import { createTrackTool } from "./track-tool.mjs";
import { createMeasureTool } from "./measure-tool.mjs";
import { createRenderTool } from "./render-tool.mjs";
import { createQaTool } from "./qa-tool.mjs";

export async function createV4ToolSet(ctx) {
	ctx.track = createTrackStore(ctx);
	const others = [createTrackTool(ctx), createMeasureTool(ctx), createRenderTool(ctx), createQaTool(ctx)];
	// ctx.signal is read at call time: it is replaced every turn.
	const host = Object.fromEntries(others.map(tool => [tool.name, args => tool.run(args ?? {}, { signal: ctx.signal, from: "js" })]));
	const js = createJsTool({ facts: rigFacts(ctx.sk, ctx.character, await ctx.records()), host });
	// refresh(): a later turn of the conversation; the js session's rig.scene takes that turn's records. True when they changed.
	return { tools: [js, ...others], close: () => js.close(), refresh: async () => js.setScene(rigFacts(ctx.sk, ctx.character, await ctx.records()).scene) };
}
