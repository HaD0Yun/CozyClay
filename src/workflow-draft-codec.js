/**
 * The localStorage form of the Workflow draft (`cozyclay.workflow.v1`).
 *
 * A picture on the canvas is a data URL, and a node keeps several copies of it
 * (fileUrl, image_url, outputs[0].value, thumbnail). Storing the graph as is
 * puts each picture in the 5 MiB browser quota up to four times (#1208).
 * The stored text instead keeps every large string once in `draftBlobs` and a
 * short reference in its place. Only the stored text changes: decode returns
 * the graph that was encoded, deep-equal, and a draft written without
 * `draftBlobs` (an older build, or one with no large strings) reads as is.
 */

const BLOB_REF = "cozyclay:draft-blob:";
const BLOB_MIN_LENGTH = 1024;

function mapStrings(value, mapString) {
	if (typeof value === "string") return mapString(value);
	if (Array.isArray(value)) return value.map((item) => mapStrings(item, mapString));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, mapString)]));
	return value;
}

/** The text to store for a normalized graph. A string that already looks like
 * a reference is tabled too, so decoding never mistakes it for one. */
export function encodeWorkflowDraft(graph) {
	const blobs = [];
	const index = new Map();
	const encoded = mapStrings(graph, (text) => {
		if (text.length < BLOB_MIN_LENGTH && !text.startsWith(BLOB_REF)) return text;
		if (!index.has(text)) index.set(text, blobs.push(text) - 1);
		return `${BLOB_REF}${index.get(text)}`;
	});
	return JSON.stringify(blobs.length ? { ...encoded, draftBlobs: blobs } : graph);
}

/** The parsed draft for stored text (null when nothing is stored). Throws on
 * text that is not JSON, like JSON.parse. */
export function decodeWorkflowDraft(text) {
	const parsed = JSON.parse(text || "null");
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.draftBlobs)) return parsed;
	const { draftBlobs: blobs, ...graph } = parsed;
	return mapStrings(graph, (value) => {
		if (!value.startsWith(BLOB_REF)) return value;
		const blob = blobs[Number(value.slice(BLOB_REF.length))];
		return typeof blob === "string" ? blob : value;
	});
}
