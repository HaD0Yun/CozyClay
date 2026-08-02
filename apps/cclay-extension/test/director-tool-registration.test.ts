import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { EMBEDDED_DIRECTOR_ELIGIBLE_TOOL_NAMES } from "@cclay/blender-tools";

/**
 * The extension validates its tool registration against the shared catalog and
 * throws DIRECTOR_TOOL_REGISTRATION_MISMATCH on drift. That guard existed and
 * was correct, but previously had no regression coverage: a catalog addition
 * without matching extension registration passed every suite and failed only
 * when a human launched the product.
 *
 * These tests close that gap. They read the registration list out of the source
 * rather than invoking the extension, because activating it requires a live
 * Blender bridge; a source-level check is enough to catch drift, which is the
 * whole failure mode.
 */

const INDEX = new URL("../src/cclay/index.ts", import.meta.url);
const SESSION = new URL("../../../packages/director-runtime/src/session.ts", import.meta.url);

/**
 * Map each catalog tool name to the factory that builds it.
 *
 * DIRECTOR_TOOL_CONSTRUCTION_PATHS in session.ts is keyed by catalog name and
 * calls exactly one factory per key, so it is the authoritative binding. An
 * earlier version of this test derived names from factory identifiers instead
 * and got createFallMotionTool wrong, because the naming is not uniform --
 * guessing the mapping is precisely the mistake to avoid here.
 */
async function factoryByToolName(): Promise<Map<string, string>> {
	const source = await readFile(SESSION, "utf8");
	const block = source.match(/DIRECTOR_TOOL_CONSTRUCTION_PATHS.*?= \{\n(.*?)\n\t\};/s);
	assert.ok(block, "could not locate DIRECTOR_TOOL_CONSTRUCTION_PATHS; update this test rather than deleting it");
	const pairs = [...block[1].matchAll(/^\t\t([a-z_]+):[\s\S]*?\bcreate([A-Za-z]+)Tool\s*\(/gm)];
	const mapping = new Map(pairs.map((match) => [match[1], match[2]]));
	assert.equal(
		mapping.size,
		EMBEDDED_DIRECTOR_ELIGIBLE_TOOL_NAMES.length,
		"every catalog tool must have exactly one construction path",
	);
	return mapping;
}

async function registeredFactories(): Promise<string[]> {
	const source = await readFile(INDEX, "utf8");
	const block = source.match(/const directorTools.*?= \[\n(.*?)\n\t\];/s);
	assert.ok(block, "could not locate the directorTools array; update this test rather than deleting it");
	return [...block[1].matchAll(/\bcreate([A-Za-z]+)Tool\s*\(/g)].map((match) => match[1]);
}

describe("director tool registration", () => {
	it("registers exactly the embedded-eligible catalog, in catalog order", async () => {
		const mapping = await factoryByToolName();
		const expected = EMBEDDED_DIRECTOR_ELIGIBLE_TOOL_NAMES.map((name) => {
			const factory = mapping.get(name);
			assert.ok(factory, `no construction path for catalog tool ${name}`);
			return factory;
		});
		assert.deepEqual(
			await registeredFactories(),
			expected,
			"extension registration drifted from EMBEDDED_DIRECTOR_ELIGIBLE_TOOLS; " +
				"the extension throws DIRECTOR_TOOL_REGISTRATION_MISMATCH at load time when this happens",
		);
	});

	it("keeps the runtime guard that enforces this", async () => {
		// If the guard is deleted, the assertion above still passes while the
		// product loses its drift protection, so pin the guard itself too.
		const source = await readFile(INDEX, "utf8");
		assert.ok(
			source.includes("DIRECTOR_TOOL_REGISTRATION_MISMATCH"),
			"the load-time registration guard must remain",
		);
		assert.ok(
			source.includes("EMBEDDED_DIRECTOR_ELIGIBLE_TOOL_NAMES"),
			"the guard must compare against the shared catalog, not a local list",
		);
	});

	it("registers all three typed ARDY tools against their host queue runners", async () => {
		const source = await readFile(INDEX, "utf8");
		assert.ok(source.includes("createArdyRegenerateTool(regenerateQueue)"));
		assert.ok(source.includes("createArdyGenerateTool(generateQueue)"));
		assert.ok(source.includes("createArdyInbetweenTool(inbetweenQueue)"));
	});

	it("gates the two host-backed ARDY tools on ARDY host configuration", async () => {
		const source = await readFile(INDEX, "utf8");
		// The gate must be the shared wrapper-derived helper, not a second
		// local notion of availability.
		assert.ok(
			source.includes("isArdyHostConfigured"),
			"the registration gate must use the shared host-availability helper",
		);
		// Both tools ride ONE conditional spread, so with no host neither is
		// registered...
		assert.match(
			source,
			/\.\.\.\(generateQueue !== undefined && inbetweenQueue !== undefined\s*\? \[createArdyGenerateTool\(generateQueue\), createArdyInbetweenTool\(inbetweenQueue\)\]\s*: \[\]\)/,
			"ardy_generate and ardy_inbetween must be constructed under one conditional on their queue runners",
		);
		// ...and the eligible-name filter must omit them on the SAME signal
		// the construction uses, or the load-time
		// DIRECTOR_TOOL_REGISTRATION_MISMATCH guard would fire whenever the
		// host is absent.
		assert.match(
			source,
			/\(name !== "ardy_generate" && name !== "ardy_inbetween"\) \|\| ardyHostConfigured/,
			"the eligible-name filter must gate on the same signal as the construction",
		);
	});
});
