import { validateStudioCommand, validateStudioIdentity, STUDIO_TOOL_SCHEMAS, STUDIO_TOOLS, StudioProtocolError } from "../../src/studio-agent-protocol.js";
import { MAX_COMMAND_TIMEOUT_MS } from "../../mcp/live-hub.mjs";
import { createRebaser } from "./studio-rebase.mjs";
import { withSculptLook } from "./sculpt-look.mjs";
import { splitPatchByDomain } from "./patch-domains.mjs";
import { NOT_READY_WAIT_MS, waitWhileNotReady } from "./wait-not-ready.mjs";

const STUDIO_TOOL_RECEIPT_NOTE = ` The result may be a receipt with status "partial": ops[].droppedPaths names exactly which authored path each op refused, and delta[].after carries the value actually landed for that target -- quote both the requested and the landed value when you report this, never say only that some paths were not applied. The sidecar re-sends a command once, by itself, when the scene revision moved but every target is unchanged, when it moved right after your own edit with nothing else changed, or when the editor was briefly mid-gesture; such a receipt carries autoRebased: true and an AUTO_REBASED warning -- mention it. A STALE_SCENE error that still reaches you lists what changed (ids and fields) and the admission is already refreshed: adapt the operation to that and resubmit it; call inspect_studio again only for ids the list does not cover; it is not a permanent failure. A TARGET_BUSY error means the user is mid-gesture; do not loop on it. A TARGET_NOT_READY that clears by itself (a rig still loading) is re-sent by the sidecar for up to ${NOT_READY_WAIT_MS / 1000} s; a receipt that needed it carries a NOT_READY_WAITED warning.`;
const STUDIO_INSPECT_NOTE = ' The per-turn context contains entityIndex and actionIndex, and relations (ON, OCCLUDED_BY, PARTLY_BEHIND, IN_FRAME, LEFT_OF, NEAR rows; scope "relations" reads them again). Read authored state and its set schemas with scope "document", optionally selecting kinds or ids; a take answers its specId (compile with base: specId), and its spec only for a character named in ids; kinds that do not fit one read are listed in omitted. Legacy scene/shot/motion/selection scopes are document projections too; runtime facts remain in context. Scope "entities" pages entity detail by ids or query. Pass nextCursor as cursor for the next page; on STALE_CURSOR restart without it. Scope "catalogue" lists placeable kinds and patchable paths.';
// Each primitive's box at scale 1, [x, y, z] m: the library's footprint width, height, footprint depth (src/scene-objects.js
// OBJECT_LIBRARY; the sidecar does not load that module, test/bus/verify-size-answers.mjs holds the two equal).
const PRIMITIVE_BOX_M = { cube: [1, 1, 1], sphere: [1, 1, 1], capsule: [0.7, 1.4, 0.7], cylinder: [1, 1, 1], cone: [1, 1, 1], plane: [2, 0, 2] };
// What src/receipt-sizes.js adds to a receipt, as it does it: the listing rule, the number, and what happens without room.
const OBJECT_SIZE_NOTE = ` At scale 1 a primitive's box is [x, y, z] m: ${Object.entries(PRIMITIVE_BOX_M).map(([kind, box]) => `${kind} [${box.join(", ")}]`).join(", ")}; scale multiplies each axis. In an agent turn or task, a "completed" receipt without nextHost states in output.sizeM, for each object whose id the scene did not have before the command or whose size changed, [x, y, z] in metres: its footprint width, height and footprint depth times its scale, the same however it is turned. When the receipt (8 KiB) cannot hold them all, it lists as many as fit and a SIZES_TRUNCATED warning counts the others. A "partial" receipt has no output: a SIZES_INLINE warning carries them, or a SIZES_OMITTED warning their count. A receipt with no room for that warning states no size.`;
const OBJECT_TOOLS = new Set(["arrange_objects", "patch_elements", "run_action"]);
const STUDIO_MUTATION_TOOLS = new Set(["operate_studio", "arrange_objects", "arrange_characters", "patch_elements", "frame_shot", "verify_result", "undo_edit", "run_action"]);
const schema = name => ({ type: "function", name, description: `Studio ${name.replaceAll("_", " ")} command.${name === "verify_result" ? " Pass exactly one of receiptId or targets (not both). An earlier receipt stays verifiable after later edits: it answers stale: true with evidenceRevision (the revision that receipt describes) beside revision (the current one), and a requested frame is captured from the current scene; report the evidence as stale, never as current." : ""}${name === "inspect_studio" ? `${STUDIO_INSPECT_NOTE} scope "actions" lists the editor actions for run_action with their availability (the reason when unavailable); with ids it answers those actions' descriptions and input schemas.` : ""}${name === "run_action" ? " Run one editor action by id (actionIndex in the context lists them) with args matching its input schema; read the schema first with inspect_studio scope \"actions\" and ids instead of guessing. A mutating action answers with a receipt (action, summary, delta) that undo_edit reverts; a job action answers status \"started\", or \"completed\" with its output when it runs to its end. A document action (scenes, the project file) answers status \"completed\" and is not undoable; when it opens another scene, its host names that scene and later commands are admitted there." : ""}${name === "patch_elements" ? " Ops of several target kinds run as one command per kind, each with its own receipt and undo entry; the answer then has splitByDomain: true and commands[] { kind, opIndices, receipt | error }." : ""}${STUDIO_MUTATION_TOOLS.has(name) ? STUDIO_TOOL_RECEIPT_NOTE : ""}${OBJECT_TOOLS.has(name) ? OBJECT_SIZE_NOTE : ""}`, parameters: STUDIO_TOOL_SCHEMAS[name] });

export function createStudioTools({ liveHub, workspaceHandle, session, resolveImage } = {}) {
  if (!liveHub?.command || !workspaceHandle) throw new StudioProtocolError("LIVE_HUB_UNAVAILABLE", "An exact Studio workspace is required.");
  const mutationNames = STUDIO_MUTATION_TOOLS;
  // The turn's command index (the context's actionIndex, from the editor's own
  // registry) carries each action's declarations: `timeoutMs` is the hub
  // deadline it runs under, which the hub bounds by MAX_COMMAND_TIMEOUT_MS.
  const declared = new Map((session?.actionIndex ?? []).map(row => [row.id, row]));
  // What the agent last saw per entity: the basis for deciding that a stale
  // revision left its targets untouched (studio-rebase.mjs).
  const rebaser = createRebaser({ session, liveHub, workspaceHandle, mutationNames, attempt: (name, args, scratch) => attempt(name, args, scratch) });
  // One admission attempt. `scratch` carries what the recovery path needs from
  // a refusal: the revision it was admitted at and the context re-read for it.
  // scratch.callId: the model's tool call this command belongs to (a script's nested commands share the script's)
  const attempt = async (name, args, scratch = {}) => {
    const command = validateStudioCommand({ name, args });
    const action = name === "run_action" ? declared.get(command.args.action) : undefined;
    const payload = mutationNames.has(name) && session?.admission
      ? { name, args: command.args, commandId: session.admission.commandId(), host: session.admission.host, expectedRevision: session.admission.revision, ...(session.admission.turnId ? { turnId: session.admission.turnId } : {}), ...(session.admission.taskId ? { taskId: session.admission.taskId } : {}), ...(typeof scratch.callId === "string" && scratch.callId ? { callId: scratch.callId } : {}) }
      : command.args;
    Object.assign(scratch, { refusedRevision: payload.expectedRevision });
    let result;
    try {
      // A motion check samples the whole take in the editor, minutes on a long
      // take, so it waits under the hub ceiling rather than the Studio default.
      const timeoutMs = name === "run_action" ? (action?.timeoutMs === undefined ? undefined : Math.min(MAX_COMMAND_TIMEOUT_MS, action.timeoutMs))
        : name === "verify_result" && command.args.checks.includes("motion") ? MAX_COMMAND_TIMEOUT_MS : undefined;
      result = await (timeoutMs === undefined ? liveHub.command(name, payload, workspaceHandle) : liveHub.command(name, payload, workspaceHandle, { timeoutMs }));
    } catch (error) {
      // A STALE_SCENE re-admits whichever family met it, so the retry the
      // model is told to make is admitted at the live revision.
      // A refresh that fails (the editor went away) keeps the error that happened, not the refresh's.
      if (session?.admission && (error?.code === "STALE_SCENE" || (mutationNames.has(name) && error?.code === "UNCERTAIN_APPLY"))) scratch.fresh = await session.admission.refresh().catch(() => null);
      throw error;
    }
    if (result?.ok === false) {
      // Rejection receipts carry code/message at the top level, not under `error`;
      // the receipt itself holds phase, recovery and target evidence the model needs.
      const code = result.code ?? result.error?.code;
      const message = result.message ?? result.error?.message ?? "Studio command failed";
      if (session?.admission && (code === "STALE_SCENE" || result.mutated === true)) scratch.fresh = await session.admission.refresh();
      throw Object.assign(new Error(message), { code, receipt: result });
    }
    // A scene action that opened another scene answers the new host; later
    // commands in this turn are admitted there, never in another workspace.
    if (name === "run_action" && result?.host && session?.admission && result.host.workspaceId === session.admission.host.workspaceId) {
      session.admission.host = validateStudioIdentity(result.host);
    }
    // An inspect reports the live revision at its top level (older editors embedded a context).
    if (name === "inspect_studio") rebaser.afterInspect(result);
    if (mutationNames.has(name) && session?.admission) {
      if (Number.isSafeInteger(result?.revision?.after)) session.admission.revision = result.revision.after; else await session.admission.refresh();
      await rebaser.observeOwnEdit(result);
    }
    return result;
  };
	const availableTools = STUDIO_TOOLS;
	// A patch_elements across domains runs as one command per domain (patch-domains.mjs); a target still loading is waited for (wait-not-ready.mjs).
	const run = splitPatchByDomain(waitWhileNotReady(rebaser.run, { signal: session?.signal, ...(session?.sleep ? { sleep: session.sleep } : {}) }));
	// A sculpt the model ran itself answers with a closeup of it attached (sculpt-look.mjs).
	const tools = availableTools.map(name => ({ ...schema(name), handler: async (args, call = {}) => withSculptLook(name, args, call, await run(name, args, call.callId ?? call.toolCallId), { invoke: rebaser.run, resolveImage: tools.resolveImage }) }));
  tools.resolveImage = async (imageId, correlation = {}) => {
    if (typeof resolveImage !== "function") return { visualStatus: "unavailable", reason: "image resolver unavailable" };
    try {
      const result = await resolveImage(imageId, correlation);
      if (!result?.dataUrl?.startsWith("data:image/")) return { visualStatus: "unavailable", reason: "editor did not provide image bytes" };
      return { visualStatus: "attached", dataUrl: result.dataUrl, imageId, revision: result.revision ?? null, receiptId: result.receiptId ?? correlation.receiptId ?? null };
    } catch { return { visualStatus: "unavailable", reason: "image attachment failed", imageId }; }
  };
  tools.internal = { invoke: run };
  return tools;
}
