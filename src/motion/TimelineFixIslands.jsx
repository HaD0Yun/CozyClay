// Fix keys by body part, under the Body group's IK keys row (motion/fix-keys.js, domains/motion/fix-islands.js). The IK
// keys row stays the summary (one dot per keyed frame). Below it one row opens per part with a fix key (head, torso, each
// arm, each leg); the chevron on the IK keys label opens a row for every part that has any key. A row holds dots only:
// a filled dot is a POSE key (the limb as dragged at that frame), a hollow dot is a REST key (the take itself). The line
// between two dots shows what plays there: thin where the pose eases in or out, solid between two pose keys.
// Drag a dot to retime it, Alt-drag to copy it (the pose holds between the two), right-click removes it, a click goes to
// its frame; Shift-click on the row adds a rest key (the part is the take's again there). The check on a row's label
// merges that part's keys into the take: the motion stays, the row clears, and the next keys are a new layer over it.
// Each edit is one undo entry.
import { useContext, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FiCheck, FiChevronDown, FiChevronRight } from "react-icons/fi";
import { AppContext } from "../app-context.js";
import { useStudioShell } from "../shell/studio-shell-context.js";
import { ko } from "../locale.js";
import { FIX_PARTS, partKeyFrames } from "./fix-weight.js";
import { partKeysOf } from "./fix-keys.js";
import { addRestKey, mergeFixKeys, moveFixKey, removeFixKey } from "../domains/motion/fix-islands.js";
import "./fix-islands.css";

const pct = (frame, count) => `${(count > 1 ? frame / (count - 1) : 0) * 100}%`;
const none = () => () => {};
const EMPTY = [];
const PART_LABEL = {
	head: () => ko("Head", "머리", "头部"), torso: () => ko("Torso", "몸통", "躯干"),
	leftArm: () => ko("Left arm", "왼팔", "左臂"), rightArm: () => ko("Right arm", "오른팔", "右臂"),
	leftLeg: () => ko("Left leg", "왼다리", "左腿"), rightLeg: () => ko("Right leg", "오른다리", "右腿"), other: () => ko("Other", "기타", "其他"),
};

// Every keyed part gets a row (open) or only the parts with a fix key (closed, the default): a viewer setting, never saved.
let partsOpen = false;
const openListeners = new Set();
const subscribeOpen = (listener) => { openListeners.add(listener); return () => openListeners.delete(listener); };
const readOpen = () => partsOpen;
const setPartsOpen = (value) => { partsOpen = Boolean(value); for (const listener of openListeners) listener(); };

/** The active character's IK keys by part: `parts` (in body order: `dots` its fix keys, `keys` the frames of its other
 * keys, `row` its row under the IK keys row or null when it has none), `open`, `rows` (how many rows the Body group grows
 * by) and `hidden` (frames whose every key is a rest key: the take itself, no dot on the summary row). */
export function useIkParts(displayFrameCount) {
	const app = useContext(AppContext), shell = useStudioShell();
	const owner = app?.storeDomain?.("motion") ?? null, characterId = shell?.activeChar?.id ?? null;
	const keys = useSyncExternalStore(owner?.documentStore.subscribe ?? none, () => (owner && characterId ? owner.read().find((row) => row.id === characterId)?.ikKeys ?? EMPTY : EMPTY));
	const open = useSyncExternalStore(subscribeOpen, readOpen, readOpen);
	const frameCount = shell?.tlFrameCount ?? displayFrameCount;
	return useMemo(() => {
		const dots = partKeysOf(keys), plain = partKeyFrames(keys);
		let rows = 0;
		const parts = FIX_PARTS.filter((part) => plain.has(part) || dots.has(part)).map((part) => {
			const shown = open || dots.has(part);
			return { part, label: PART_LABEL[part](), dots: dots.get(part) ?? EMPTY, keys: plain.get(part) ?? EMPTY, row: shown ? rows++ : null };
		});
		const hidden = new Set(keys.filter((row) => { const tracks = Object.values(row.tracks ?? {}); return tracks.length > 0 && tracks.every((key) => key.fix?.kf && key.fix.rest); }).map((row) => row.frame));
		return { owner, characterId, frameCount, parts, open, rows, hidden };
	}, [owner, characterId, keys, frameCount, open]);
}

/** The chevron on the IK keys row's label: a row for every keyed part, or only the parts with a fix key. */
export function IkPartsToggle({ ikParts }) {
	if (!ikParts.parts.length) return null;
	const label = ikParts.open ? ko("Show only the parts with a fix key", "보정 키가 있는 파츠만 보기", "仅显示有修正关键帧的部位") : ko("Show a row for every keyed body part", "키가 있는 모든 파츠를 줄로 펼치기", "为每个有关键帧的部位展开一行");
	return (
		<button type="button" className="tl-ik-parts-toggle" data-testid="ik-parts-toggle" aria-expanded={ikParts.open} aria-label={label} title={label} onClick={() => setPartsOpen(!ikParts.open)}>
			{ikParts.open ? <FiChevronDown size={12} aria-hidden="true" /> : <FiChevronRight size={12} aria-hidden="true" />}
		</button>
	);
}

/** What a merge did, as a toast (also FixTools' Merge all). */
export function mergeNotice({ merged, left }, label = null) {
	const head = label ? `${label}: ` : "";
	if (merged) return head + ko(`${merged} key${merged === 1 ? "" : "s"} merged into the motion${left ? `, ${left} could not be merged` : ""}. Undo brings ${merged === 1 ? "it" : "them"} back`,
		`키 ${merged}개를 모션에 병합했어요${left ? ` (${left}개는 병합할 수 없어요)` : ""}. 실행 취소하면 돌아와요`, `已将 ${merged} 个关键帧合并进动作${left ? `（${left} 个无法合并）` : ""}。撤销可恢复`);
	return head + ko("these keys cannot be merged (finger bones, or a part that also has a plain IK key)", "이 키들은 병합할 수 없어요 (손가락 뼈이거나, 일반 IK 키가 같이 있는 파츠)", "这些关键帧无法合并（手指骨骼，或该部位同时有普通 IK 键）");
}

/** The part rows' labels, under the IK keys label: the part, its pose key count, and Merge (the check). */
export function IkPartLabels({ ikParts }) {
	const app = useContext(AppContext);
	return ikParts.parts.filter((entry) => entry.row !== null).map(({ part, label, dots }) => {
		const poses = dots.filter((dot) => !dot.rest).length;
		const merge = ko(`Merge the ${label.toLowerCase()} keys into the motion: the take's own frames take this motion, the row clears, and the next keys start a new layer over it`,
			`${label} 키를 모션에 병합: 테이크의 프레임 자체가 이 동작이 되고, 줄이 비워져서, 다음 키는 그 위에 새로 쌓여요`, `将${label}关键帧合并进动作：片段自身的帧变为此动作，行清空，之后的关键帧在其上新建一层`);
		return (
			<span key={part} className="tl-track-subrow indent tl-ik-part-row" data-ik-part={part}>
				<span className="tl-track-chip ik-part" data-lane-label={label}>{label}</span>
				{poses > 0 && <em className="tl-ik-part-count" title={ko(`${poses} pose key${poses === 1 ? "" : "s"}`, `포즈 키 ${poses}개`, `${poses} 个姿势关键帧`)}>{poses}</em>}
				{poses > 0 && <button type="button" className="tl-ik-part-merge" data-fix-merge={part} aria-label={merge} title={merge}
					onClick={() => app?.notify?.(mergeNotice(mergeFixKeys(ikParts.owner, ikParts.characterId, part), label))}><FiCheck size={12} aria-hidden="true" /></button>}
			</span>
		);
	});
}

export function FixIslandBands({ displayFrameCount, ikParts, onJump }) {
	const { owner, characterId, frameCount, parts } = ikParts;
	// the dot being dragged: { part, from, to, copy }
	const [drag, setDrag] = useState(null);
	const laneRef = useRef(null);
	if (!owner || !characterId || !parts.length) return <span ref={laneRef} hidden />;
	const frameAt = (event) => {
		const lane = laneRef.current?.parentElement?.getBoundingClientRect();
		return lane?.width ? Math.max(0, Math.min(frameCount - 1, Math.round(((event.clientX - lane.left) / lane.width) * Math.max(1, displayFrameCount - 1)))) : 0;
	};
	const press = (event, part, frame) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		setDrag({ part, from: frame, to: frame, copy: event.altKey });
	};
	const move = (event) => { if (drag) { const to = frameAt(event); if (to !== drag.to) setDrag({ ...drag, to }); } };
	const release = () => {
		if (!drag) return;
		setDrag(null);
		if (drag.to === drag.from) onJump?.(drag.from);
		else moveFixKey(owner, characterId, drag.part, drag.from, drag.to, drag.copy);
	};
	return (
		<span ref={laneRef} className="tl-fix-islands">
			{parts.map(({ part, label, dots, keys, row: at }) => {
				if (at === null) return null;
				const row = { "--fix-row": at + 2 };
				// the dots as they would stand if the drag ended now (a copy leaves its source in place)
				const live = drag?.part === part && drag.to !== drag.from && !dots.some((dot) => dot.frame === drag.to) ? drag : null;
				// Rendered in the stored order, never re-sorted: moving a dot's DOM node would drop the pointer capture mid-drag.
				const placed = live ? [...dots.map((dot) => (dot.frame === live.from && !live.copy ? { ...dot, frame: live.to, source: dot.frame, moving: true } : dot)), ...(live.copy ? [{ ...dots.find((dot) => dot.frame === live.from), frame: live.to, source: live.from, moving: true, ghost: true }] : [])] : dots;
				const shown = placed.slice().sort((a, b) => a.frame - b.frame);
				return (
					<span key={part} className="tl-fix-part" data-ik-part={part}>
						<i className="tl-fix-part-line" style={row} aria-hidden="true" />
						<span className="tl-fix-row-hit" style={row} data-fix-row={part}
							title={ko(`${label}: click to go to a frame, Shift-click to add a rest key there (the ${label.toLowerCase()} is the take's again)`, `${label}: 클릭하면 그 프레임으로 가고, Shift-클릭하면 거기에 원본 키를 넣어요 (${label}이(가) 다시 테이크대로 움직여요)`, `${label}：点击跳转到该帧，Shift+点击在该处添加原始关键帧（${label}恢复为片段动作）`)}
							onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); const frame = frameAt(event); if (event.shiftKey) addRestKey(owner, characterId, part, frame); else onJump?.(frame); }} />
						{shown.slice(1).map((dot, i) => {
							const from = shown[i], kind = from.rest && dot.rest ? null : !from.rest && !dot.rest ? "pose" : from.rest ? "in" : "out";
							return kind && <i key={`seg:${from.frame}`} className={"tl-fix-seg " + kind} data-fix-seg={kind} style={{ ...row, left: pct(from.frame, displayFrameCount), width: `calc(${pct(dot.frame, displayFrameCount)} - ${pct(from.frame, displayFrameCount)})` }} aria-hidden="true" />;
						})}
						{keys.map((frame) => (
							<span key={`key:${frame}`} className="tl-part-key" data-part-key={frame} style={{ ...row, left: pct(frame, displayFrameCount) }}
								title={ko(`${label}: IK key at frame ${frame}. Click to go there`, `${label}: ${frame}프레임 IK 키. 클릭하면 그 프레임으로 가요`, `${label}：第 ${frame} 帧的 IK 键。点击跳转`)}
								onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); onJump?.(frame); }} />
						))}
						{placed.map((dot) => {
							const title = dot.rest ? ko(`${label}: rest key at frame ${dot.frame} (the take itself). Drag to change where the pose eases in or out, right-click to remove it`, `${label}: ${dot.frame}프레임 원본 키 (테이크 그대로). 끌어서 포즈가 들어오고 빠지는 곳을 바꾸고, 오른쪽 클릭으로 지워요`, `${label}：第 ${dot.frame} 帧原始关键帧（片段本身）。拖动更改姿势渐入渐出的位置，右键删除`)
								: ko(`${label}: pose key at frame ${dot.frame}. Drag to retime it, Alt-drag to copy it (the pose holds between the two), right-click to remove it`, `${label}: ${dot.frame}프레임 포즈 키. 끌어서 타이밍을 바꾸고, Alt를 누른 채 끌면 복제되어 둘 사이에서 포즈가 유지되고, 오른쪽 클릭으로 지워요`, `${label}：第 ${dot.frame} 帧姿势关键帧。拖动调整时间，按住 Alt 拖动复制（两者之间保持姿势），右键删除`);
							const source = dot.source ?? dot.frame;
							return <span key={dot.ghost ? "copy" : source} className={"tl-fix-key" + (dot.rest ? " rest" : "") + (dot.moving ? " moving" : "")} data-fix-key={dot.frame} data-fix-part={part} data-fix-rest={dot.rest || undefined}
								style={{ ...row, left: pct(dot.frame, displayFrameCount) }} title={title} aria-label={title}
								onPointerDown={(event) => press(event, part, source)} onPointerMove={move} onPointerUp={release} onPointerCancel={() => setDrag(null)} onLostPointerCapture={() => setDrag(null)}
								onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); removeFixKey(owner, characterId, part, source); }} />;
						})}
					</span>
				);
			})}
		</span>
	);
}
