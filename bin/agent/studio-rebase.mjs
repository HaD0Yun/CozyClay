// Auto-rebase policy for a Studio command refused at admission.
//
// STALE_SCENE and TARGET_BUSY are admission refusals: the editor applied
// nothing. The agent used to pay a whole model turn per refusal (inspect, then
// resubmit). This module decides, conservatively and from evidence, when the
// identical command may be re-sent once, and what to tell the model when it may
// not. Pure functions over plain context/entity rows; no I/O but `fetchRows`.
//
// What "unchanged" means. The editor mints one `token` per entity and rotates
// it whenever any non-display field of that entity changes (position, rotation,
// scale, colour, parent, motion, ...; display-only name/tint do not rotate it).
// The agent's baseline is the token it last SAW for an id:
//   - the turn's own context (detailed rows),
//   - inspect_studio rows,
//   - the state right after the agent's own applied command (read back from the
//     authoritative context at the revision that command published),
//   - the fresh state quoted in an earlier teaching error.
// An entity the agent merely saw as an index row (id/name/position) has no
// token and cannot be proven unchanged.
//
// The editor settling the agent's own edit. A receipt answers the revision its
// command published, but the editor can move the revision once more a render
// later (a document mirror catching up). When the refused admission is the one
// the agent's own last edit published, and nothing it has not authored changed,
// that move is not news: any tool is re-sent once (`own_edit_settled`).
import { annotateRebased, busyTeaching, staleTeaching } from "./studio-rebase-text.mjs";
import { GESTURE_WAIT_MS, isGestureBusy, sleepUnlessAborted, waitOutGesture } from "./studio-busy-wait.mjs";

const IDENTITY = ["workspaceId", "documentEpoch", "sceneId", "sceneEpoch"];
/** Tools whose targets are entities with tokens. Shot/stage patches, framing, actions,
 * undo and view changes carry no per-entity fingerprint: retried only on a settle. */
const REBASE_TOOLS = new Set(["arrange_objects", "arrange_characters", "patch_elements"]);
const DISPLAY_SKIP = new Set(["token", "detailsOmitted"]);
const MAX_LINES = 8, MAX_FIELDS = 6;

const round = value => typeof value === "number" ? Math.round(value * 100) / 100 : value;
const norm = value => Array.isArray(value) ? value.map(norm)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, norm(value[key])])) : round(value);
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const show = value => {
  const n = norm(value);
  if (n && typeof n === "object" && ["x", "y", "z"].every(axis => typeof n[axis] === "number")) return `(${n.x}, ${n.y}, ${n.z})`;
  const text = JSON.stringify(n);
  return text === undefined ? "absent" : text.length > 48 ? `${text.slice(0, 47)}…` : text;
};
const sameHost = (a, b) => Boolean(a && b) && IDENTITY.every(key => a[key] === b[key]);
const nameKey = value => typeof value === "string" ? value.normalize("NFC").trim().toLowerCase() : null;

/** The agent's record of what it last saw per entity id. */
function createSeen(baseline) {
  const rows = new Map();   // id -> detailed row carrying a token
  const known = new Set();  // every id the agent has been shown, detailed or indexed
  const index = new Map();  // id -> last compact row (name/position) the agent saw
  const seen = {
    hasBaseline: false,
    rows, known,
    observeRow(row) {
      if (!row || typeof row.id !== "string") return;
      known.add(row.id);
      if (typeof row.token === "string") { rows.set(row.id, structuredClone(row)); index.set(row.id, { name: row.name, position: row.position }); }
      else seen.observeIndexRow(row);
    },
    observeIndexRow(row) {
      if (!row || typeof row.id !== "string") return;
      known.add(row.id);
      const before = rows.get(row.id);
      // A compact row that disagrees with the stored detail is newer knowledge
      // without a token: the stored token no longer describes what was seen.
      if (before && (!same(before.name, row.name) || !same(before.position, row.position))) rows.delete(row.id);
      index.set(row.id, { name: row.name, position: row.position });
    },
    /** Everything in a context (or only `only` ids) was shown to the agent. */
    observeContext(context, only = null) {
      if (!context || typeof context !== "object") return;
      const wanted = id => !only || only.has(id);
      const detailed = new Set();
      for (const row of Array.isArray(context.entities) ? context.entities : []) { detailed.add(row?.id); if (wanted(row?.id)) seen.observeRow(row); }
      for (const row of Array.isArray(context.entityIndex) ? context.entityIndex : []) if (!detailed.has(row?.id) && wanted(row?.id)) seen.observeIndexRow(row);
      if (!only) seen.hasBaseline = true;
    },
    /** Result of any tool: inspect rows and context, read defensively from either shape. */
    observeResult(result) {
      if (!result || typeof result !== "object") return;
      if (result.context) seen.observeContext(result.context);
      for (const row of Array.isArray(result.entities) ? result.entities : []) seen.observeRow(row);
    },
    /** The agent no longer holds a verifiable view of these ids. */
    forget(ids) { for (const id of ids) rows.delete(id); },
    drop(ids) { for (const id of ids) { rows.delete(id); known.delete(id); index.delete(id); } },
  };
  if (baseline) seen.observeContext(baseline);
  return seen;
}

/** Every id-shaped string an argument tree mentions. Over-approximate on purpose:
 * a string that merely equals an entity id makes that entity a target. */
function referencedStrings(value, out = new Set()) {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const item of value) referencedStrings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) referencedStrings(item, out);
  return out;
}

function eligibility(name, args) {
  if (!REBASE_TOOLS.has(name)) return `${name} reads state with no per-entity fingerprint, so it is replayed automatically only right after your own edit, and only when nothing else changed`;
  if (name === "patch_elements" && args.ops.some(op => op?.target?.kind !== "object" && op?.target?.kind !== "character")) return "shot and stage edits have no per-entity fingerprint, so they are replayed automatically only right after your own edit, and only when nothing else changed";
  return null;
}

function diffRow(base, current) {
  if (current.detailsOmitted) return [];
  const fields = [...new Set([...Object.keys(base), ...Object.keys(current)])].filter(key => !DISPLAY_SKIP.has(key));
  const lines = [];
  for (const key of fields) if (!same(base[key], current[key])) lines.push(`${key} ${show(base[key])} -> ${show(current[key])}`);
  return lines;
}

const rowsById = rows => new Map((Array.isArray(rows) ? rows : []).filter(row => typeof row?.id === "string").map(row => [row.id, row]));

/** Compare the agent's baseline with the fresh authoritative context. */
function surveyChanges(seen, fresh, extraRows = new Map()) {
  const detailed = rowsById(fresh?.entities);
  for (const [id, row] of extraRows) detailed.set(id, row);
  const indexed = rowsById(fresh?.entityIndex);
  const changed = [], removed = [], unchecked = [];
  for (const [id, base] of seen.rows) {
    const current = detailed.get(id);
    if (current) { if (current.token !== base.token || !same(base.name, current.name)) changed.push({ id, fields: diffRow(base, current) }); }
    else if (indexed.has(id)) unchecked.push(id);
    else removed.push(id);
  }
  for (const id of seen.known) if (!seen.rows.has(id) && !detailed.has(id) && !indexed.has(id)) removed.push(id);
  const added = [...new Set([...detailed.keys(), ...indexed.keys()])].filter(id => !seen.known.has(id));
  return { changed, removed: [...new Set(removed)], added, unchecked };
}

const describeChanges = (survey, only = null) => {
  const wanted = id => !only || only.has(id);
  const lines = [];
  for (const { id, fields } of survey.changed) if (wanted(id)) lines.push(`${id}: ${fields.length ? fields.slice(0, MAX_FIELDS).join("; ") : "changed (fields not itemised)"}`);
  const removed = survey.removed.filter(wanted);
  if (removed.length) lines.push(`removed: ${removed.slice(0, 8).join(", ")}`);
  if (!only && survey.added.length) lines.push(`added: ${survey.added.slice(0, 8).join(", ")}${survey.added.length > 8 ? ` (+${survey.added.length - 8})` : ""}`);
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `(+${lines.length - MAX_LINES} more)`] : lines;
};

/**
 * Decide whether the refused command may be re-sent once.
 * Retry only when ALL hold:
 *  1. the tool is arrange_objects, arrange_characters, or patch_elements on object/character targets;
 *  2. the refusal proved nothing was applied (the caller checks the receipt);
 *  3. the fresh context is the SAME document identity and its revision differs from the one refused;
 *  4. every id the arguments mention that the agent knows is still present, with the SAME token and
 *     name the agent last saw (a token the agent never saw counts as changed);
 *  5. for create ops, no entity the agent has not seen carries the same name.
 */
async function decideRebase({ name, args, seen, fresh, host, refusedRevision, ownRevision, fetchRows }) {
  const survey = () => surveyChanges(seen, fresh, extra);
  const extra = new Map();
  const result = (retry, reason, targets = [], only = null) => ({ retry, reason, targets, survey: survey(), lines: describeChanges(survey(), only) });
  if (!fresh || typeof fresh !== "object" || !fresh.revision) return { retry: false, reason: "no fresh context", targets: [], survey: null, lines: [] };
  if (!sameHost(host, fresh.host)) return result(false, "the live document or scene changed, not just its contents");
  if (fresh.revision.scene === refusedRevision) return result(false, "the scene revision did not move, so a resend would be refused the same way");
  const moved = survey();
  if (refusedRevision === ownRevision && !moved.changed.length && !moved.removed.length && !moved.added.length) return { ...result(true, "own edit settled"), settled: true };
  const blocked = eligibility(name, args);
  if (blocked) return result(false, blocked);

  const freshIds = new Set([...rowsById(fresh.entities).keys(), ...rowsById(fresh.entityIndex).keys()]);
  const mentioned = referencedStrings(args);
  const targets = [...new Set([...mentioned].filter(value => seen.known.has(value) || freshIds.has(value)))];
  const ops = Array.isArray(args.ops) ? args.ops : [];
  const creates = ops.filter(op => op?.op === "create");
  if (!targets.length && !seen.hasBaseline) return result(false, "the agent has no recorded view of the scene to compare against");

  const detailed = rowsById(fresh.entities);
  const needDetail = targets.filter(id => !detailed.has(id) && freshIds.has(id));
  if (needDetail.length && typeof fetchRows === "function") {
    try { for (const row of await fetchRows(needDetail)) if (typeof row?.id === "string" && typeof row.token === "string") extra.set(row.id, row); } catch { /* unverifiable below */ }
  }
  const current = id => extra.get(id) ?? detailed.get(id);
  const reasons = [];
  for (const id of targets) {
    const base = seen.rows.get(id), row = current(id);
    if (!freshIds.has(id)) reasons.push(`${id} no longer exists`);
    else if (!seen.known.has(id)) reasons.push(`${id} is new since you last looked`);
    else if (!base) reasons.push(`${id} was not read with detail since it last changed (or you edited it before the edit reached you); its state cannot be proven unchanged`);
    else if (!row) reasons.push(`${id} could not be re-read`);
    else if (row.token !== base.token) reasons.push(`${id} was edited by someone else`);
    else if (!same(base.name, row.name)) reasons.push(`${id} was renamed`);
  }
  if (reasons.length) {
    const only = new Set(targets);
    return { ...result(false, reasons.join("; "), targets, only), failedTargets: reasons };
  }
  const taken = new Map();
  for (const row of [...rowsById(fresh.entities).values(), ...rowsById(fresh.entityIndex).values()]) if (!seen.known.has(row.id) && nameKey(row.name)) taken.set(nameKey(row.name), row.id);
  const collisions = creates.map(op => nameKey(op.name)).filter(key => key && taken.has(key));
  if (collisions.length) return result(false, `an object named "${collisions[0]}" appeared since you last looked (${taken.get(collisions[0])})`, targets);
  return result(true, "targets unchanged", targets);
}

// One bounded wait for any other TARGET_BUSY (an open transaction) to end; the user's gesture is waited out
// with backoff for up to 20 s instead (studio-busy-wait.mjs).
const BUSY_WAIT_MS = 1200;

/**
 * The recovery wrapper around one admission attempt (`attempt(name, args, scratch)`
 * in studio-tools.mjs, which fills `scratch.fresh`, `.refusedRevision`).
 * Exactly one re-send per call, whichever refusal: a second one is the model's.
 */
export function createRebaser({ session, liveHub, workspaceHandle, mutationNames, attempt }) {
  const seen = createSeen(session?.baseline);
  const admission = session?.admission;
  let ownRevision = null; // the revision the agent's own last authored edit published
  /** An inspect result re-admits at its revision (either result shape) and shows the agent entity state. */
  const afterInspect = result => {
    const revision = result?.context?.revision?.scene ?? result?.revision?.scene ?? result?.revision;
    if (Number.isSafeInteger(revision) && admission) admission.revision = revision;
    seen.observeResult(result);
  };
  // The agent's own applied command is the newest thing it knows about the
  // entities it touched. When the receipt carries their tokens use them;
  // otherwise read the authoritative context, trusting it only at the revision
  // that command published (nothing slipped in between).
  const observeOwnEdit = async result => {
    const affected = new Set(Array.isArray(result?.affectedIds) ? result.affectedIds : []);
    if (result?.ok !== false && Number.isSafeInteger(result?.revision?.after) && result.revision.after !== result.revision.before) ownRevision = result.revision.after;
    if (!affected.size || result?.ok === false) return;
    const tokened = new Set();
    for (const item of Array.isArray(result.delta) ? result.delta : []) {
      if (affected.has(item?.id) && typeof item.after?.token === "string") { tokened.add(item.id); seen.observeRow({ ...(seen.rows.get(item.id) ?? {}), ...item.after, id: item.id }); }
    }
    const rest = new Set([...affected].filter(id => !tokened.has(id)));
    if (!rest.size) return;
    seen.forget(rest);
    if (typeof admission?.snapshot !== "function") return;
    try {
      const snapshot = await admission.snapshot();
      const present = new Set([...(snapshot.entities ?? []), ...(snapshot.entityIndex ?? [])].map(row => row.id));
      // A later revision may hold someone else's edit too: the agent then knows these ids
      // (its own edit made or kept them, so they are not "added"), not their state.
      if (snapshot?.revision?.scene === admission.revision) seen.observeContext(snapshot, rest);
      else for (const id of rest) if (present.has(id)) seen.known.add(id);
      seen.drop([...rest].filter(id => !present.has(id)));
    } catch { /* the edit stays unverifiable; a later stale is simply not retried */ }
  };
  const fetchRows = async ids => {
    const read = await liveHub.command("inspect_studio", { scope: "entities", ids: ids.slice(0, 32), limit: Math.min(32, ids.length) }, workspaceHandle);
    return Array.isArray(read?.entities) ? read.entities : [];
  };
  // callId: the model's tool call (studio-tools.mjs), carried by every send of this command
  const run = async (name, args, callId) => {
    const scratch = { callId };
    try { return await attempt(name, args, scratch); }
    catch (error) {
      const refused = error?.receipt?.mutated === undefined || error.receipt.mutated === false; // nothing applied, provably
      if (!admission || !mutationNames.has(name) || name === "verify_result" || !refused) throw error;
      const targetIds = () => [...referencedStrings(args)].filter(id => seen.known.has(id));
      if (error?.code === "TARGET_BUSY") {
        // The user's gesture: re-send with backoff until it ends (up to 20 s). Anything else busy: one pause, one re-send.
        const gesture = isGestureBusy(error), pause = gesture ? 0 : session.busyWaitMs ?? BUSY_WAIT_MS, sleep = session.sleep ?? sleepUnlessAborted;
        if (pause && !await sleep(pause, session.signal)) throw error;
        try {
          const waited = await waitOutGesture(() => attempt(name, args, { callId }), { refused: gesture ? error : null, signal: session.signal, sleep, onWait: session.onGestureWait, maxMs: gesture ? session.gestureWaitMs ?? GESTURE_WAIT_MS : 0 });
          return annotateRebased(waited.result, { reason: "target_busy", waitedMs: pause + waited.waitedMs, retried: true, ...(gesture ? { tries: waited.tries } : {}) });
        } catch (second) {
          if (second?.code !== "TARGET_BUSY" || session.signal?.aborted) throw second;
          throw Object.assign(new Error(busyTeaching({ original: second.message, waitedMs: pause + (second.waitedMs ?? 0), ids: targetIds() })), { code: "TARGET_BUSY", receipt: second.receipt, autoRebased: false });
        }
      }
      if (error?.code !== "STALE_SCENE" || !scratch.fresh) throw error;
      const fromRevision = scratch.refusedRevision, fresh = scratch.fresh;
      let verdict;
      try { verdict = await decideRebase({ name, args, seen, fresh, host: admission.host, refusedRevision: fromRevision, ownRevision, fetchRows }); }
      catch { throw error; }
      if (!verdict.retry) {
        // The teaching error quotes the fresh state of what it lists, so that is
        // now what the agent has seen of those ids.
        seen.observeContext(fresh, new Set([...verdict.survey?.changed.map(item => item.id) ?? [], ...verdict.targets]));
        seen.drop(verdict.survey?.removed ?? []);
        throw Object.assign(new Error(staleTeaching({ original: error.message, verdict, refusedRevision: fromRevision, freshRevision: fresh.revision?.scene ?? admission.revision, name })), { code: "STALE_SCENE", receipt: error.receipt, autoRebased: false });
      }
      const unrelated = (verdict.survey?.changed.length ?? 0) + (verdict.survey?.added.length ?? 0) + (verdict.survey?.removed.length ?? 0);
      const again = { callId };
      let result;
      try { result = await attempt(name, args, again); }
      catch (second) {
        // The one re-send was spent. Say what moved so the model need not guess.
        if (second?.code !== "STALE_SCENE" || !again.fresh) throw second;
        let more = null;
        try { more = await decideRebase({ name, args, seen, fresh: again.fresh, host: admission.host, refusedRevision: again.refusedRevision, fetchRows }); } catch { /* plain error below */ }
        const verdict2 = { ...(more ?? { lines: [], survey: null, targets: [] }), reason: `it was already re-sent once automatically (revision ${fromRevision} -> ${fresh.revision.scene}) and the scene moved again` };
        throw Object.assign(new Error(staleTeaching({ original: second.message, verdict: verdict2, refusedRevision: again.refusedRevision, freshRevision: again.fresh.revision?.scene ?? admission.revision, name })), { code: "STALE_SCENE", receipt: second.receipt, autoRebased: false });
      }
      return annotateRebased(result, { reason: verdict.settled ? "own_edit_settled" : "stale_scene", fromRevision, toRevision: fresh.revision.scene, retried: true, targets: verdict.targets, unrelatedChanges: unrelated });
    }
  };
  return { seen, afterInspect, observeOwnEdit, run };
}
