// The words the auto-rebase policy (studio-rebase.mjs) hands the model: the teaching text of a
// refusal it did not re-send, and the warning on a receipt it did. Pure string building.
const MESSAGE_CAP = 900;

const trim = text => text.length > MESSAGE_CAP ? `${text.slice(0, MESSAGE_CAP - 1)}…` : text;

/** The teaching text appended to a STALE_SCENE the agent must handle itself. */
export function staleTeaching({ original, verdict, refusedRevision, freshRevision, name }) {
  const detail = verdict.lines.length ? ` What changed since you last looked: ${verdict.lines.join(" | ")}.` : "";
  const why = verdict.reason === "no fresh context" ? "" : ` Not retried automatically: ${verdict.reason}.`;
  return trim(`${original}${why}${detail} Your admission is already refreshed to revision ${freshRevision}${refusedRevision !== undefined ? ` (was ${refusedRevision})` : ""}: adapt ${name} to the state above and resubmit it; inspect again only for ids not listed.`);
}

/** The teaching text for a TARGET_BUSY that outlived the wait. */
export function busyTeaching({ original, waitedMs, ids }) {
  const gesture = /gesture/i.test(original);
  const target = ids.length ? ` (it targets ${ids.slice(0, 6).join(", ")})` : "";
  return trim(gesture
    ? `${original} The user is still dragging or editing in the editor after ${Math.round(waitedMs / 1000)} s${target}; nothing was applied. This is not a failure of your work and does not end the task: tell the user you are waiting for them to let go, then call this tool again.`
    : `${original} Nothing was applied. Waited ${waitedMs} ms and retried once, still busy${target}. Do not loop on this tool: finish or cancel the open operation, or ask the user.`);
}

/** Mark a result that only succeeded because the sidecar re-sent it. */
export function annotateRebased(result, info) {
  const message = trim(info.reason === "target_busy"
    ? `Editor was mid-gesture; waited ${info.waitedMs} ms for the user and re-sent the command.`
    : info.reason === "own_edit_settled"
      ? `Scene revision moved ${info.fromRevision} -> ${info.toRevision} after your own edit, with nothing else changed; command re-sent once.`
      : `Scene revision moved ${info.fromRevision} -> ${info.toRevision} by edits that left the targets unchanged; command re-sent once.`).slice(0, 120);
  const warnings = [...(Array.isArray(result?.warnings) ? result.warnings : []), { code: "AUTO_REBASED", message }];
  return { ...result, autoRebased: true, autoRebase: info, warnings };
}
