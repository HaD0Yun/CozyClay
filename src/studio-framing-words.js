// Common spellings of a frame_shot intent, read as the declared words before the schema check (#1042):
// "medium" or "MS" is "medium shot", "close up" is "close-up", "side" is "profile", "eye level" is "eye".
// A first call that names a size, view or level the way a crew would should land, not be refused for a
// hyphen. Only exact table hits change; anything else reaches the validator, whose refusal lists the
// allowed values. Shared by the browser and the sidecar: no imports.
const SIZES = {
	"extreme close-up": ["extreme close up", "extreme closeup", "ecu", "xcu", "bcu", "big close up"],
	"close-up": ["close up", "closeup", "cu"],
	"medium close-up": ["medium close up", "medium closeup", "mcu"],
	"medium shot": ["medium", "mid", "mid shot", "ms", "waist", "waist shot"],
	"medium-wide shot": ["medium wide", "medium wide shot", "mws", "medium long", "medium long shot", "mls", "cowboy", "cowboy shot", "american", "american shot"],
	"wide shot": ["wide", "ws", "long", "long shot", "ls", "full", "full shot", "fs", "full body"],
	"extreme wide shot": ["extreme wide", "extreme long", "extreme long shot", "ews", "els", "xws", "xls", "establishing", "establishing shot"],
};
const VIEWS = {
	front: ["frontal", "front view", "head on", "facing"],
	"front three-quarter": ["three quarter", "three quarters", "3/4", "front 3/4", "front three quarter", "front three quarters", "three quarter front", "34"],
	profile: ["side", "side view", "profile view"],
	"rear three-quarter": ["rear three quarter", "rear 3/4", "back three quarter", "back 3/4", "three quarter back", "three quarter rear"],
	back: ["rear", "behind", "back view", "from behind"],
};
const LEVELS = {
	ground: ["ground level", "floor", "floor level", "worm", "worms eye", "worm's eye"],
	low: ["low angle", "low level"],
	hip: ["hip level", "waist level", "hip height"],
	eye: ["eye level", "eye height", "eyeline", "neutral", "straight"],
	high: ["high angle", "high level"],
	overhead: ["top", "top down", "top-down", "birds eye", "bird's eye", "bird's-eye", "birdseye", "aerial"],
};
const SIDES = { left: ["l", "camera left"], right: ["r", "camera right"] };

const key = value => value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const lookup = table => {
	const map = new Map();
	for (const [word, spellings] of Object.entries(table)) for (const spelling of [word, ...spellings]) map.set(key(spelling), word);
	return value => (typeof value === "string" ? map.get(key(value)) ?? value : value);
};
const size = lookup(SIZES), view = lookup(VIEWS), level = lookup(LEVELS), side = lookup(SIDES);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** frame_shot / shot.frame args with the intent's words in their declared spelling, and a lone subject id
 * (subjectIds: "char-a") as the one-item list the schema takes. Returns a new object; never throws. */
export function normalizeFramingArgs(args) {
	if (!record(args)) return args;
	const next = { ...args };
	if (typeof next.subjectIds === "string") next.subjectIds = [next.subjectIds];
	const intent = record(next.framing) && record(next.framing.intent) ? next.framing.intent : null;
	if (intent) {
		const words = { ...intent };
		for (const [field, read] of [["size", size], ["view", view], ["level", level], ["side", side]]) if (field in words) words[field] = read(words[field]);
		next.framing = { ...next.framing, intent: words };
	}
	return next;
}
