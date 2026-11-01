// C9. motion.describe { topic, name? }: the spec's schema, a valid example and notes. The field
// lists come from schema/fields.js, their types from schema/types.js, channels from
// compiler/vocab.js, FIX_KEYS from fix/index.js, the skills from skills/index.js and
// skills/info.js; examples and notes from schema/topics.js. Every answer fits DESCRIBE_BUDGET.
//   topic "essentials"          { topic, types: { <topic or shared shape>: type line }, skills: [{ name, args (type line), needs, frames, adds }], notes }
//                               (the lines of MEANT parts carry each field's meaning; SHALLOW topics name their parts only)
//   other topic                 { topic, schema (JSON Schema 2020-12 fragment), example, notes }
//   topic "skills"              { topic, skills: [{ name, args, needs, frames, adds }] }
//   topic "skills", name        { topic, name, schema (the skill's args), example (a use entry), notes }
//   topic "examples"            { topic, examples: [{ name, scene, spec }] (whole specs, schema/spec-examples.js), notes }
// motion.describe { topics: [{ topic, name? }] } (describeMany): { topics: [those answers, in order], more?: [the asks that
// did not fit] }, so a request's topics cost one call; the Studio prompt already carries essentials and goals.
import { SPEC_FIELDS, KEY_FIELDS, USE_FIELDS, ANCHOR_FIELDS, PROP_FIELDS, FIT_FIELDS, OBJECT_FIELDS, WALK_FIELDS, CHECK_FIELDS, CHECK_ENTRY_FIELDS,
	GOAL_FIELDS, PROBE_FIELDS, REF_KINDS, DESCRIBE_TOPICS } from "./schema/fields.js";
import { DEFS, SPEC_TYPES, KEY_TYPES, USE_TYPES, WALK_TYPES, ANCHOR_TYPES, ANCHOR_REQUIRED, PROP_TYPES, FIT_TYPES, OBJECT_TYPES, FREE_TYPES, CHECK_ENTRY_TYPES, CHECK_REQUIRED, CHECKS_TYPES,
	GOAL_TYPES, PROBE_TYPES, FIX_TYPES, REF_DOCS } from "./schema/types.js";
import { EXAMPLES, NOTES } from "./schema/topics.js";
import { SPEC_EXAMPLES, EXAMPLE_NOTES } from "./schema/spec-examples.js";
import { briefType } from "./schema/brief.js";
import { VEC_CHANNELS, NUM_CHANNELS, MAP_CHANNELS, SKILL_CHANNELS, FINGER_PRESETS, CHANNEL_DOCS, channelFamily, rangeOf, didYouMean } from "./compiler/vocab.js";
import { FIX_KEYS } from "./fix/index.js";
import { SKILL_NAMES } from "./skills/index.js";
import { SKILL_INFO } from "./skills/info.js";

/** Bytes of JSON a describe answer may take: the 8 KiB receipt minus 768 B for a describe receipt's
 * head (569 B in a live Studio receipt: ids, host, revision, summary; no readback, it changes nothing). */
export const DESCRIBE_BUDGET = 8192 - 768;

const bad = msg => { throw new Error(`MOTION_SPEC_INVALID: ${msg}`); };
const typeOf = (types, f, table) => types[f] ?? bad(`describe: ${table}.${f} has no type in schema/types.js`);

/** { type: object } with exactly `fields`, each typed from `types`. */
const objectOf = (fields, types, table, required = []) => ({ type: "object", properties: Object.fromEntries(fields.map(f => [f, typeOf(types, f, table)])),
	...(required.length ? { required } : {}), additionalProperties: false });
const listOf = (items, extra) => ({ type: "array", items, ...extra });
const oneOfRequired = names => ({ oneOf: names.map(n => ({ required: [n] })) });

const LOCAL_DEFS = {
	key: () => objectOf(KEY_FIELDS, KEY_TYPES, "key", ["f", "set"]),
	use: () => { const o = objectOf(USE_FIELDS, USE_TYPES, "use", ["skill", "f0"]); o.properties.skill = { enum: SKILL_NAMES }; return o; },
	walk: () => objectOf(WALK_FIELDS, WALK_TYPES, "generators[i]", ["type", "f0"]),
};

/** The schema with $schema and the $defs it (transitively) refers to. */
function rooted(schema) {
	const defs = {}, all = { ...DEFS, ...LOCAL_DEFS };
	for (let more = true; more;) {
		more = false;
		const json = JSON.stringify([schema, defs]);
		for (const [name, d] of Object.entries(all)) if (!defs[name] && json.includes(`"#/$defs/${name}"`)) { defs[name] = typeof d === "function" ? d() : d; more = true; }
	}
	return { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema, ...(Object.keys(defs).length ? { $defs: defs } : {}) };
}

function channelSchema(ch) {
	const twin = ch.replace(/_r$/, "_l");
	if (twin !== ch && (VEC_CHANNELS.has(twin) || NUM_CHANNELS.has(twin) || MAP_CHANNELS.has(twin))) return { $ref: `#/properties/${twin}` };
	const r = rangeOf(ch), d = CHANNEL_DOCS[channelFamily(ch)] ?? bad(`describe: channel ${ch} has no entry in CHANNEL_DOCS`);
	if (VEC_CHANNELS.has(ch)) return { $ref: "#/$defs/vec3", description: d };
	if (MAP_CHANNELS.has(ch)) return { type: "object", propertyNames: { enum: FINGER_PRESETS }, additionalProperties: { type: "number", minimum: 0, maximum: 1 } };
	return r ? { type: "number", minimum: r[1], maximum: r[2], description: r[3] } : { type: "number", description: d };
}

const SCHEMAS = {
	spec: () => objectOf(SPEC_FIELDS, SPEC_TYPES, "spec", ["schema", "frames"]),
	anchors: () => ({ type: "object", description: "name -> anchor", additionalProperties: { oneOf: Object.entries(ANCHOR_FIELDS).map(([kind, fields]) =>
		objectOf(["kind", ...fields], { ...ANCHOR_TYPES, kind: { const: kind } }, `anchors (${kind})`, ["kind", ...(ANCHOR_REQUIRED[kind] ?? [])])) } }),
	props: () => ({ type: "object", properties: {
		props: { type: "object", description: "name -> prop", additionalProperties: objectOf(PROP_FIELDS, PROP_TYPES, "props", ["hand", "origin"]) },
		fits: listOf(objectOf(FIT_FIELDS, FIT_TYPES, "fits", ["side", "anchor", "effector"])) } }),
	objects: () => ({ type: "object", description: "object or group id -> hinge, carry, switch, follow or free", additionalProperties: { oneOf: [
		{ title: "hinge", ...objectOf(OBJECT_FIELDS.hinge, OBJECT_TYPES, "objects (hinge)", ["pivot", "channel"]) },
		{ title: "carry", ...objectOf(OBJECT_FIELDS.carry, OBJECT_TYPES, "objects (carry)", ["prop"]) },
		{ title: "switch", ...objectOf(OBJECT_FIELDS.switch, OBJECT_TYPES, "objects (switch)") },
		{ title: "follow", ...objectOf(OBJECT_FIELDS.follow, OBJECT_TYPES, "objects (follow)", ["follow"]) },
		{ title: "free", ...objectOf(OBJECT_FIELDS.free, { ...OBJECT_TYPES, ...FREE_TYPES }, "objects (free)") }] } }),
	checks: () => ({ type: "object", properties: Object.fromEntries(CHECK_FIELDS.map(f => [f, CHECK_ENTRY_FIELDS[f]
		? listOf(objectOf(CHECK_ENTRY_FIELDS[f], CHECK_ENTRY_TYPES, `checks.${f}`, CHECK_REQUIRED[f]))
		: typeOf(CHECKS_TYPES, f, "checks")])), additionalProperties: false }),
	goals: () => listOf({ ...objectOf(GOAL_FIELDS, GOAL_TYPES, "goals", ["name", "at"]), ...oneOfRequired(["near", "above", "moved", "still", "speed"]) }),
	probes: () => listOf({ ...objectOf(PROBE_FIELDS, PROBE_TYPES, "probes", ["name"]), ...oneOfRequired(["distance", "position"]) }, { maxItems: 16 }),
	channels: () => ({ type: "object", description: "key.set: channel -> value",
		properties: Object.fromEntries([...VEC_CHANNELS, ...NUM_CHANNELS, ...MAP_CHANNELS].filter(ch => !SKILL_CHANNELS.has(ch)).map(ch => [ch, channelSchema(ch)])),
		patternProperties: { "^w_.+_[lr]$": { type: "number", minimum: 0, maximum: 1, description: rangeOf("w_a_l")[3] }, "_vis$": { type: "number", description: "shown > 0.5" } },
		additionalProperties: { type: "number", description: "spec.channels, an object's or a check's when" } }),
	refs: () => ({ type: "string", oneOf: REF_KINDS.map(k => ({ pattern: `^${k}:`, description: typeOf(REF_DOCS, k, "refs") })) }),
	fix: () => ({ oneOf: [{ const: false }, objectOf(FIX_KEYS, FIX_TYPES, "fix")] }),
};

function skillArgs(name) {
	const { args, required = [] } = SKILL_INFO[name] ?? bad(`describe: skill ${name} has no entry in skills/info.js`);
	return Object.entries(args).map(([a, s]) => `${a}${required.includes(a) ? "*" : ""}${s.default !== undefined ? `=${JSON.stringify(s.default)}` : ""}`).join(", ");
}

function describeSkill(name) {
	const info = SKILL_INFO[name] ?? bad(`describe: skill ${name} has no entry in skills/info.js`);
	return { topic: "skills", name, schema: rooted({ type: "object", properties: info.args, ...(info.required ? { required: info.required } : {}), additionalProperties: false }),
		example: { skill: name, ...info.example }, notes: [`needs: ${info.needs}`, `frames from f0: ${info.frames}`, `adds: ${info.adds.join("; ")}`] };
}

/** The parts round-2 sessions read again right after essentials (topics objects and channels, skill
 * reachGrip): in essentials their fields also say what they mean, so a first spec needs no second read. */
const MEANT = { topics: ["objects", "channels"], skills: ["reachGrip"] };
/** Topics no round-2 session needed for a first spec: essentials names their parts, the full topic has the fields. */
const SHALLOW = ["checks"];
/** Skills essentials leaves to topic skills: a flip, a cartwheel or a body thrown by a hit is no first spec's need, and essentials has no room. */
const FIRST_SPEC_SKIP = ["flip", "hitReaction", "throwObject", "catchObject"];

/** A shared shape whose fields are mostly a skill's args (walk, walkTo): its own fields and `...<skill> args`. */
function shapeLine(d) {
	for (const [skill, { args }] of Object.entries(SKILL_INFO)) {
		const own = Object.entries(d.properties ?? {}).filter(([k, v]) => JSON.stringify(args[k]) !== JSON.stringify(v)), shared = Object.keys(d.properties ?? {}).length - own.length;
		if (shared <= own.length) continue;
		const not = Object.keys(args).filter(a => !d.properties[a]);
		return briefType({ ...d, properties: Object.fromEntries(own) }).replace(/\}$/, `, ...${skill} args${not.length ? ` but ${not.join(", ")}` : ""}}`);
	}
	return briefType(d) + (d.description ? ` (${d.description})` : "");
}

/** The spec schema with each field a topic spells ("topic anchors") named by that topic's type line: `anchors?: anchors`, `fits?: props.fits`. */
function pointed(spec) {
	const at = (f, t) => (t === f && !SCHEMAS[t]().properties?.[f] ? t : `${t}.${f}`);
	return { ...spec, properties: Object.fromEntries(Object.entries(spec.properties).map(([f, s]) => {
		const t = s.description?.match(/\btopic (\w+)\)?$/)?.[1];
		return [f, t && SCHEMAS[t] && t !== "skills" ? { $ref: `#/types/${at(f, t)}` } : s];
	})) };
}

/** Every topic's schema and every skill's args as one type line each, and the shared shapes they name. */
function essentials() {
	const types = {}, shared = {};
	for (const topic of DESCRIBE_TOPICS.filter(t => SCHEMAS[t])) {
		const { $defs = {}, ...schema } = rooted(topic === "spec" ? pointed(SCHEMAS.spec()) : SCHEMAS[topic]());
		types[topic] = briefType(schema, { means: MEANT.topics.includes(topic), depth: SHALLOW.includes(topic) ? 1 : undefined });
		Object.assign(shared, $defs);
	}
	// use.skill without the enum: the skills list below names them
	if (shared.use) shared.use = objectOf(USE_FIELDS, USE_TYPES, "use", ["skill", "f0"]);
	// a skill no first spec needs (FIRST_SPEC_SKIP) is in topic skills only
	const skills = SKILL_NAMES.filter(n => !FIRST_SPEC_SKIP.includes(n)).map(n => {
		const { args, required = [], needs, frames, adds } = SKILL_INFO[n] ?? bad(`describe: skill ${n} has no entry in skills/info.js`);
		return { name: n, args: briefType({ type: "object", properties: args, required }, { means: MEANT.skills.includes(n) }), needs, frames, adds };
	});
	// the shared shapes a line names as a type (": vec3", "| frameSpan", "[ref, ref]"); a shallow topic names fewer than its schema has
	const named = name => new RegExp(`(?:[:|] |[[(])${name}\\b`).test(JSON.stringify([types, skills.map(k => k.args)]));
	for (let more = true; more;) {
		more = false;
		for (const [name, d] of Object.entries(shared)) if (!types[name] && named(name)) { types[name] = shapeLine(d); more = true; }
	}
	return { topic: "essentials", types, skills, notes: NOTES.essentials };
}

/** describe(topic, name?) -> the answer for one topic (see the table above). */
export function describe(topic, name) {
	if (!DESCRIBE_TOPICS.includes(topic)) bad(`topic "${topic}" is not a describe topic${didYouMean(String(topic), DESCRIBE_TOPICS)} (topics: ${DESCRIBE_TOPICS.join(", ")})`);
	if (topic === "essentials") return essentials();
	if (topic === "examples") return { topic, examples: SPEC_EXAMPLES, notes: EXAMPLE_NOTES };
	if (topic === "fill") return { topic, notes: NOTES.fill };
	if (topic !== "skills") return { topic, schema: rooted(SCHEMAS[topic]()), example: EXAMPLES[topic], notes: NOTES[topic] };
	if (name === undefined) return { topic, skills: SKILL_NAMES.map(n => ({ name: n, args: skillArgs(n), needs: SKILL_INFO[n].needs, frames: SKILL_INFO[n].frames, adds: SKILL_INFO[n].adds })) };
	if (!SKILL_NAMES.includes(name)) bad(`skill "${name}" is not a skill${didYouMean(String(name), SKILL_NAMES)} (skills: ${SKILL_NAMES.join(", ")})`);
	return describeSkill(name);
}

const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

/** describeMany([{ topic, name? }]) -> { topics, more? }: the answers in order while they fit DESCRIBE_BUDGET (the first
 * always does), each ask once; the rest are named in `more` for another call. */
export function describeMany(asks) {
	const seen = new Set(), wanted = asks.filter(({ topic, name }) => !seen.has(`${topic} ${name ?? ""}`) && seen.add(`${topic} ${name ?? ""}`));
	const topics = [];
	for (const [i, { topic, name }] of wanted.entries()) {
		const answer = describe(topic, name), rest = wanted.slice(i + 1);
		if (topics.length && bytes({ topics: [...topics, answer], more: rest }) > DESCRIBE_BUDGET) return { topics, more: wanted.slice(i) };
		topics.push(answer);
	}
	return { topics };
}
