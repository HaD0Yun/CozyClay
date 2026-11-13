// The four demos (src/lowvis/demos.js) as motion3 specs. Each builder takes the body's numbers (engine.js bodyOf)
// and returns { characters: { id: spec }, objects?: scene records, props?(clip), lines, notes }.
import { locomotion } from "./locomotion.js";
import { sit } from "./sit.js";
import { object } from "./object.js";
import { duo } from "./duo.js";

export const SPECS = { locomotion, sit, object, duo };
