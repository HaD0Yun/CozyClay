// What frame_shot (studio-agent-commands.js frameDraft) needs before it measures: the character and a mounted
// shot camera. Each refusal says what is wrong and what to send instead (#1042): an object id is the wrong kind
// (INVALID_ARGUMENT, with its field for studio:refused), an id not in the scene is STALE_TARGET, a hidden
// character or a camera still loading is TARGET_NOT_READY, with what to do next.
import { StudioProtocolError } from './studio-agent-protocol.js';

const fail = (code, message, details) => { throw new StudioProtocolError(code, message, details); };

/** The visible character `subjectId` names in `state`, once the shot camera and filmback are there. */
export function frameSubject(subjectId, state, sensorFormats) {
  const subject = state.characters.find(e => e.id === subjectId);
  if (!subject || subject.hidden) {
    const visible = state.characters.filter(e => !e.hidden).map(e => e.id);
    const list = visible.length ? `Visible character ids: ${visible.slice(0, 12).join(', ')}.` : 'No character is visible; add or show one first.';
    if (subject) fail('TARGET_NOT_READY', `${subjectId} is hidden, so it cannot be framed; show it (arrange_characters update hidden: false) or frame another character. ${list}`);
    if (state.objects?.some(o => o.id === subjectId)) fail('INVALID_ARGUMENT', `$.args.subjectIds[0]: ${subjectId} is an object; frame_shot frames a character. ${list}`, { path: '$.args.subjectIds[]', rule: 'check' });
    fail('STALE_TARGET', `$.args.subjectIds[0]: no character ${subjectId} in this scene. ${list}`);
  }
  if (!state.camera || !sensorFormats[state.filmback?.sensorId] || !(state.filmback.aspectRatio > 0)) fail('TARGET_NOT_READY', 'The shot camera is not mounted yet (the editor is still loading); wait a moment and send the same frame_shot again.');
  return subject;
}
