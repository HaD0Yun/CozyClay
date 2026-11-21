// What frame_shot (studio-agent-commands.js frameDraft) needs before it measures: the character and a mounted
// shot camera. Each refusal says what is wrong and what to send instead (#1042): an object id is the wrong kind
// (INVALID_ARGUMENT, with its field for studio:refused), an id not in the scene is STALE_TARGET, a hidden
// character or a camera still loading is TARGET_NOT_READY, with what to do next.
import { StudioProtocolError } from './studio-agent-protocol.js';
import { CAMERA_PRESETS, cameraPresetFraming } from './camera-move.js';
import { createShotSubjectSampler } from './camera-direction.js';
import { subjectsCenter } from './shot-subjects.js';
import { shotAtFrame } from './cuts.js';
import { SUBJECT_HEIGHT_M } from './shot.js';

const fail = (code, message, details) => { throw new StudioProtocolError(code, message, details); };

export const frameSubjectsAt = (raw, shots, fps) => createShotSubjectSampler({ characters: raw.characters, objects: raw.objects, shots, frameCount: raw.frameCount, fps, activeId: raw.activeCharacterId, clipOf: entry => raw.targets.get(entry.id)?.motion ?? null });

/** Expand an editor preset using the shot's subjects, preserving hidden references. */
export function presetFrameArgs(presetId, raw, shots, fps) {
  const preset = CAMERA_PRESETS[presetId];
  if (!preset) fail('INVALID_ARGUMENT', 'Unknown camera preset');
  const shot = shotAtFrame(shots, raw.view.frame) ?? shots.find(shot => shot.id === raw.selectedShotId);
  const members = frameSubjectsAt(raw, shots, fps)(shot, raw.view.frame), subject = subjectsCenter(members);
  if (!subject) fail('TARGET_NOT_READY', 'No named visible character is available to frame.');
  const height = SUBJECT_HEIGHT_M * (members[0].scale ?? 1), framing = cameraPresetFraming(presetId, { ...subject, height }, raw.filmback);
  return { namedSubjectIds: shot?.subjectIds, args: { subjectIds: members.map(member => member.id), framing: members.length > 1
    ? { intent: { size: preset.subjectFraction >= 0.5 ? 'medium-wide shot' : 'wide shot', level: 'high', view: 'front three-quarter', side: 'left', focalMm: preset.focalMm } }
    : { exact: { position: { ...framing.pos, y: framing.pos.y + subject.y }, lookAt: { x: subject.x, y: subject.y + height * 0.52, z: subject.z }, focalMm: framing.focalMm } } } };
}

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
