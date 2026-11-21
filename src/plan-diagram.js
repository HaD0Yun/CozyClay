// The Top View the Studio agent reads (verify_result visual "plan",
// capture_plan_png): a 2D data diagram drawn from editor state, not a render.
// planDiagramLayout computes the world->pixel transform and a list of
// primitives; drawPlanDiagram paints them on any 2D canvas context.
// Pure: no renderer, no React, no DOM.
import { isEffectivelyHidden } from './scene-objects.js';
import { shotAtFrame } from './cuts.js';
import { axisSubjects, occludersOf, primarySubjects, shotCamera, sideOfAxis } from './studio-geometry-facts.js';
import { entityWorldBounds } from './studio-agent-commands.js';
import { characterName } from './character-name.js';

export const PLAN_DIAGRAM = Object.freeze({ marginM: 1.5, maxSpanM: 30, minSpanM: 6, characterRadiusM: 0.3, frustumM: 3, defaultFovDeg: 40 });
const SIDE_LABEL = { left: 'L', right: 'R', 'on-axis': 'on-axis' };
const GROUP_HUES = ['#c9a46a', '#a8c47a', '#d39a8c', '#8fb7c9', '#c0a0d0', '#d6c06a'];
const round = v => Math.round(v * 1000) / 1000 + 0;
const flat = p => ({ x: round(p.x), z: round(p.z) });

function groupRoot(object, objects) {
  let node = object;
  for (let guard = 0; node?.parent && guard < 64; guard += 1) {
    const parent = objects.find(o => o.id === node.parent);
    if (!parent) break;
    node = parent;
  }
  return node;
}

/** Footprint corners in world x/z: width*scaleX by depth*scaleZ, turned by rot (yaw deg, 0 = +Z, positive toward +X). */
function footprintCorners(o) {
  const w = (o.footprint?.width ?? 0) * (o.scaleX ?? 1) / 2, d = (o.footprint?.depth ?? 0) * (o.scaleZ ?? 1) / 2;
  const yaw = (o.rot ?? 0) * Math.PI / 180, c = Math.cos(yaw), s = Math.sin(yaw);
  return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([lx, lz]) => flat({ x: o.x + lx * c + lz * s, z: o.z - lx * s + lz * c }));
}

/**
 * The diagram's content and framing. `options`: width/height of the output in
 * pixels, `ports` for world bounds (occluders), `currentShotId` (defaults to
 * the shot under state.frame), `aspect` of the shot frame for the horizontal FOV.
 */
export function planDiagramLayout(state, { width = 1280, height = 720, ports, currentShotId, aspect = 16 / 9 } = {}) {
  const visible = e => !isEffectivelyHidden(e, state.objects, state.characters);
  const characters = state.characters.filter(visible);
  // A carried prop's numbers are local to the bone it rides, so it has no floor spot of its own.
  const objects = state.objects.filter(o => visible(o) && !o.attach);
  const shots = [...(state.shotDocument?.shots ?? [])].sort((a, b) => a.startFrame - b.startFrame);
  const currentId = currentShotId ?? shotAtFrame(shots, state.frame ?? 0)?.id ?? null;
  const primitives = [];

  // Largest footprints first, so a ground plane never covers the props standing on it.
  const area = o => (o.footprint?.width ?? 0) * (o.scaleX ?? 1) * (o.footprint?.depth ?? 0) * (o.scaleZ ?? 1);
  for (const o of [...objects].sort((p, q) => area(q) - area(p))) {
    const root = groupRoot(o, state.objects), grouped = root !== o || state.objects.some(child => child.parent === o.id);
    const hue = grouped ? GROUP_HUES[[...root.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % GROUP_HUES.length] : '#d8c39a';
    primitives.push({ kind: 'object', id: o.id, label: o.name || o.id, center: flat(o), corners: footprintCorners(o), groupId: grouped ? root.id : null, fill: hue });
  }
  for (const c of characters) {
    const yaw = (c.rot ?? 0) * Math.PI / 180;
    primitives.push({ kind: 'character', id: c.id, label: characterName(c), x: round(c.x), z: round(c.z), radius: PLAN_DIAGRAM.characterRadiusM, facing: flat({ x: Math.sin(yaw), z: Math.cos(yaw) }) });
  }
  shots.forEach((shot, index) => {
    const camera = shotCamera(shot, state);
    if (!camera) return;
    const fovDeg = shot.cameraKeys?.[0]?.framing?.fovDeg ?? PLAN_DIAGRAM.defaultFovDeg;
    const halfFov = Math.atan(Math.tan(fovDeg * Math.PI / 360) * aspect), heading = Math.atan2(camera.lookAt.x - camera.position.x, camera.lookAt.z - camera.position.z);
    const edge = angle => flat({ x: camera.position.x + Math.sin(angle) * PLAN_DIAGRAM.frustumM, z: camera.position.z + Math.cos(angle) * PLAN_DIAGRAM.frustumM });
    const current = shot.id === currentId, entry = { kind: 'camera', shotId: shot.id, label: `S${index + 1}`, current, position: flat(camera.position), lookAt: flat(camera.lookAt),
      halfFovRad: round(halfFov), frustum: [edge(heading - halfFov), edge(heading + halfFov)], cameraSide: null };
    primitives.push(entry);
    if (!current) return;
    const subjects = primarySubjects(shot.subjectIds ?? [], camera.position, state), pair = axisSubjects(shot.subjectIds ?? [], camera.position, state);
    if (pair.length === 2) {
      entry.cameraSide = SIDE_LABEL[sideOfAxis(pair[0], pair[1], camera.position)] ?? null;
      primitives.push({ kind: 'actionLine', shotId: shot.id, subjectIds: pair.map(c => c.id), a: flat(pair[0]), b: flat(pair[1]), distanceM: round(Math.hypot(pair[1].x - pair[0].x, pair[1].z - pair[0].z)), cameraSide: entry.cameraSide });
    }
    if (!ports) return;
    for (const subject of subjects) {
      const box = entityWorldBounds(subject, state, ports);
      if (!box) continue;
      for (const hit of occludersOf(subject, camera.position, state, ports, box)) {
        const blocker = state.objects.find(o => o.id === hit.byObjectId);
        primitives.push({ kind: 'occluder', shotId: shot.id, subjectId: hit.subjectId, byObjectId: hit.byObjectId, corners: blocker && !blocker.attach ? footprintCorners(blocker) : [],
          segment: { from: flat(camera.position), to: flat({ x: (box.min.x + box.max.x) / 2, z: (box.min.z + box.max.z) / 2 }) } });
      }
    }
  });

  // Fit everything visible plus a margin, keep the output aspect, cap the span.
  // A capped view centres on the cast and cameras, so the action stays in frame.
  const box = points => {
    const xs = points.map(p => p.x), zs = points.map(p => p.z);
    return xs.length ? { min: { x: Math.min(...xs), z: Math.min(...zs) }, max: { x: Math.max(...xs), z: Math.max(...zs) } } : null;
  };
  const action = box(primitives.flatMap(p => p.kind === 'character' ? [p] : p.kind === 'camera' ? [p.position] : []));
  const { min, max } = box(primitives.flatMap(p => p.kind === 'object' ? [p.center, ...p.corners] : p.kind === 'character' ? [p] : p.kind === 'camera' ? [p.position] : [])) ?? { min: { x: 0, z: 0 }, max: { x: 0, z: 0 } };
  const pixelAspect = width / height;
  let spanX = max.x - min.x + 2 * PLAN_DIAGRAM.marginM, spanZ = max.z - min.z + 2 * PLAN_DIAGRAM.marginM;
  spanZ = Math.max(spanZ, PLAN_DIAGRAM.minSpanM);
  if (spanX / spanZ < pixelAspect) spanX = spanZ * pixelAspect; else spanZ = spanX / pixelAspect;
  const cap = Math.min(1, PLAN_DIAGRAM.maxSpanM / Math.max(spanX, spanZ));
  spanX *= cap; spanZ *= cap;
  const focus = cap < 1 && action ? action : { min, max }, centre = { x: (focus.min.x + focus.max.x) / 2, z: (focus.min.z + focus.max.z) / 2 };
  const scale = width / spanX, view = { minX: centre.x - spanX / 2, maxX: centre.x + spanX / 2, minZ: centre.z - spanZ / 2, maxZ: centre.z + spanZ / 2 };
  primitives.unshift({ kind: 'grid', stepM: 1, labelStepM: 2, ...Object.fromEntries(Object.entries(view).map(([k, v]) => [k, round(v)])) });
  // +X to the right, +Z down the image.
  const toPixel = p => [(p.x - view.minX) * scale, (p.z - view.minZ) * scale];
  return { width, height, scale: round(scale), view, toPixel, currentShotId: currentId, primitives };
}

/** Paint the plan diagram on a 2D context of the output size; returns the layout. */
export function drawPlanDiagram(ctx, state, options = {}) {
  const layout = planDiagramLayout(state, options), { width, height, scale, view, toPixel } = layout;
  const path = (corners, close = true) => {
    ctx.beginPath();
    corners.forEach((p, i) => { const [x, y] = toPixel(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (close) ctx.closePath();
  };
  const text = (value, x, y, colour = '#222', align = 'left') => {
    ctx.textAlign = align; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(250, 248, 242, 0.9)'; ctx.fillStyle = colour;
    ctx.strokeText(value, x, y); ctx.fillText(value, x, y);
  };
  ctx.fillStyle = '#f7f5ef'; ctx.fillRect(0, 0, width, height);
  ctx.font = '500 13px system-ui, sans-serif'; ctx.textBaseline = 'middle';
  for (const p of layout.primitives) {
    if (p.kind === 'grid') {
      for (let x = Math.ceil(view.minX); x <= view.maxX; x += 1) {
        const [px] = toPixel({ x, z: 0 });
        ctx.strokeStyle = x === 0 ? '#9a968c' : x % 2 ? '#e8e5dc' : '#d9d5ca'; ctx.lineWidth = x === 0 ? 1.5 : 1;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, height); ctx.stroke();
        if (x % 2 === 0) text(`x ${x}`, px + 3, height - 10, '#6d695f');
      }
      for (let z = Math.ceil(view.minZ); z <= view.maxZ; z += 1) {
        const [, py] = toPixel({ x: 0, z });
        ctx.strokeStyle = z === 0 ? '#9a968c' : z % 2 ? '#e8e5dc' : '#d9d5ca'; ctx.lineWidth = z === 0 ? 1.5 : 1;
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(width, py); ctx.stroke();
        if (z % 2 === 0) text(`z ${z}`, 4, py - 8, '#6d695f');
      }
      const [ox, oy] = toPixel({ x: 0, z: 0 });
      ctx.strokeStyle = '#5c584f'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ox, oy, 5, 0, Math.PI * 2); ctx.stroke();
      text('0', ox + 8, oy + 10, '#5c584f');
    } else if (p.kind === 'object') {
      ctx.fillStyle = p.fill; ctx.strokeStyle = '#8a7350'; ctx.lineWidth = 1.5;
      if (p.corners.some((c, i) => c.x !== p.corners[(i + 2) % 4].x || c.z !== p.corners[(i + 2) % 4].z)) { path(p.corners); ctx.fill(); ctx.stroke(); }
      const [x, y] = toPixel(p.center);
      text(p.label.length > 24 ? `${p.label.slice(0, 23)}\u2026` : p.label, x, y, '#4a3b22', 'center');
    } else if (p.kind === 'character') {
      const [x, y] = toPixel(p), r = p.radius * scale, [fx, fy] = toPixel({ x: p.x + p.facing.x * (p.radius + 0.35), z: p.z + p.facing.z * (p.radius + 0.35) });
      ctx.fillStyle = '#6ea8e0'; ctx.strokeStyle = '#2f6aa8'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(fx, fy); ctx.stroke();
      const head = Math.atan2(fy - y, fx - x);
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx - 8 * Math.cos(head - 0.5), fy - 8 * Math.sin(head - 0.5)); ctx.lineTo(fx - 8 * Math.cos(head + 0.5), fy - 8 * Math.sin(head + 0.5)); ctx.closePath(); ctx.fillStyle = '#2f6aa8'; ctx.fill();
      // The name goes behind the character, so two people facing each other keep their labels apart.
      const behind = p.facing.x >= 0 ? -1 : 1, name = p.label.length > 24 ? `${p.label.slice(0, 23)}\u2026` : p.label;
      text(name, x + behind * (r + 4), y - r - 6, '#1f4f80', behind < 0 ? 'right' : 'left');
    } else if (p.kind === 'camera') {
      const [cx, cy] = toPixel(p.position), [lx, ly] = toPixel(p.lookAt);
      ctx.fillStyle = p.current ? 'rgba(214, 64, 52, 0.22)' : 'rgba(120, 120, 120, 0.14)'; ctx.strokeStyle = p.current ? '#d64034' : '#7d7a73'; ctx.lineWidth = p.current ? 2 : 1.25;
      path([p.position, ...p.frustum]); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(lx, ly); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      if (p.current) { ctx.fillStyle = '#d64034'; ctx.fill(); } else { ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke(); }
      text(p.cameraSide ? `${p.label} (${p.cameraSide})` : p.label, cx + 9, cy + 12, p.current ? '#b02d22' : '#55524b');
    } else if (p.kind === 'actionLine') {
      const [ax, ay] = toPixel(p.a), [bx, by] = toPixel(p.b);
      ctx.strokeStyle = '#3c7d3a'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
      text(`${p.distanceM.toFixed(2)} m`, (ax + bx) / 2, (ay + by) / 2 - 12, '#2d5f2b', 'center');
    } else if (p.kind === 'occluder') {
      ctx.strokeStyle = '#e0241b'; ctx.lineWidth = 3;
      if (p.corners.length) { path(p.corners); ctx.stroke(); }
      const [fx, fy] = toPixel(p.segment.from), [tx, ty] = toPixel(p.segment.to);
      ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(tx, ty); ctx.stroke();
    }
  }
  // Legend, top-right.
  const rows = [['character', '#6ea8e0'], ['object', '#d8c39a'], ['camera (filled: current shot)', '#d64034'], ['action line', '#3c7d3a'], ['blocked sight line', '#e0241b']];
  const lx = width - 236, ly = 12;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'; ctx.strokeStyle = '#c9c4b8'; ctx.lineWidth = 1;
  ctx.fillRect(lx, ly, 224, rows.length * 20 + 12); ctx.strokeRect(lx, ly, 224, rows.length * 20 + 12);
  rows.forEach(([name, colour], i) => {
    ctx.fillStyle = colour; ctx.fillRect(lx + 10, ly + 12 + i * 20, 14, 10);
    ctx.fillStyle = '#333'; ctx.textAlign = 'left'; ctx.fillText(name, lx + 32, ly + 17 + i * 20);
  });
  return layout;
}
