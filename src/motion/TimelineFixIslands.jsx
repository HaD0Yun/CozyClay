// Fix islands on the Body group's IK keys row (domains/motion/fix-islands.js): each island is a band over the frames its
// correction reaches, behind its key dot (the timeline draws the dot; dragging the dot retimes the whole island). Dragging a
// band edge sets how far it reaches (one undo entry on release); right-click on the band removes the island.
import { useContext, useRef, useState, useSyncExternalStore } from "react";
import { AppContext } from "../app-context.js";
import { useStudioShell } from "../shell/studio-shell-context.js";
import { ko } from "../locale.js";
import { islandsOf } from "./fix-weight.js";
import { removeFix, setFixReach } from "../domains/motion/fix-islands.js";
import "./fix-islands.css";

const pct = (frame, count) => `${(count > 1 ? frame / (count - 1) : 0) * 100}%`;
const none = () => () => {};
const EMPTY = [];

export function FixIslandBands({ displayFrameCount }) {
	const app = useContext(AppContext), shell = useStudioShell();
	const owner = app?.storeDomain?.("motion") ?? null, characterId = shell?.activeChar?.id ?? null;
	const rows = useSyncExternalStore(owner?.documentStore.subscribe ?? none, () => (owner && characterId ? owner.read().find((row) => row.id === characterId)?.ikKeys ?? EMPTY : EMPTY));
	const [drag, setDrag] = useState(null);
	const laneRef = useRef(null);
	const frameCount = shell?.tlFrameCount ?? displayFrameCount;
	const islands = islandsOf(rows, frameCount);
	if (!owner || !characterId || !islands.length) return <span ref={laneRef} hidden />;
	const frameAt = (event) => {
		const lane = laneRef.current?.parentElement?.getBoundingClientRect();
		return lane?.width ? Math.round(((event.clientX - lane.left) / lane.width) * Math.max(1, displayFrameCount - 1)) : 0;
	};
	const startEdge = (event, island, edge) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		setDrag({ frame: island.frame, edge, before: island.before, after: island.after });
	};
	const moveEdge = (event, island) => {
		if (drag?.frame !== island.frame) return;
		const at = frameAt(event);
		setDrag(drag.edge === "start" ? { ...drag, before: Math.max(0, Math.min(island.frame, island.frame - at)) }
			: { ...drag, after: Math.max(0, Math.min(frameCount - 1 - island.frame, at - island.frame)) });
	};
	const endEdge = (island) => {
		if (drag?.frame !== island.frame) return;
		setDrag(null);
		setFixReach(owner, characterId, island.frame, drag.before, drag.after);
	};
	return (
		<span ref={laneRef} className="tl-fix-islands">
			{islands.map((island) => {
				const reach = drag?.frame === island.frame ? drag : island, start = island.frame - reach.before, end = island.frame + reach.after;
				const label = ko(`Fix f${start}–${end}: the correction eases in and out over these frames. Drag an edge to change them, right-click to remove the fix`,
					`보정 f${start}–${end}: 이 프레임에서 보정이 들어오고 빠져요. 가장자리를 끌어 범위를 바꾸고, 오른쪽 클릭으로 보정을 지워요`,
					`修正 f${start}–${end}：修正在这些帧内渐入渐出。拖动边缘可更改范围，右键删除修正`);
				return (
					<span key={island.id} className={"tl-fix-island" + (drag?.frame === island.frame ? " dragging" : "")} data-fix-island={island.id} data-fix-frame={island.frame}
						style={{ left: pct(start, displayFrameCount), width: `calc(${pct(end, displayFrameCount)} - ${pct(start, displayFrameCount)})` }}
						title={label} aria-label={label}
						onPointerDown={(event) => { if (event.button === 0) event.stopPropagation(); }}
						onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); removeFix(owner, characterId, island.frame); }}>
						<span className="tl-fix-edge start" data-fix-edge="start" onPointerDown={(event) => startEdge(event, island, "start")} onPointerMove={(event) => moveEdge(event, island)} onPointerUp={() => endEdge(island)} />
						<span className="tl-fix-edge end" data-fix-edge="end" onPointerDown={(event) => startEdge(event, island, "end")} onPointerMove={(event) => moveEdge(event, island)} onPointerUp={() => endEdge(island)} />
					</span>
				);
			})}
		</span>
	);
}
