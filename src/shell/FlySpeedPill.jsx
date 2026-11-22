import { useEffect, useRef, useState } from "react";
import { ko } from "../locale.js";
import { clampFlySpeed, stepFlySpeed } from "../fly-speed.js";
import RailIcon from "./RailIcon.jsx";

const shown = (value, digits) => String(Number(value.toFixed(digits)));
const parse = (text) => clampFlySpeed(String(text).replace(/[×x]\s*$/i, "").trim().replace(",", "."));

/** The viewport's fly speed readout. A click opens a field beside it: type a
 * number (Enter or a click outside applies, Escape cancels) or step it with
 * the arrows; the wheel over the pill steps it too. Every way uses the same
 * range and 10 % step as the wheel during a right-drag (fly-speed.js), and
 * writes the one speed FlyControls flies with. */
export default function FlySpeedPill({ flySpeed, setFlySpeed }) {
	const [draft, setDraft] = useState(null);
	const wrap = useRef(null);
	const pill = useRef(null);
	const field = useRef(null);
	const open = draft !== null;

	const close = (commit) => {
		const next = commit ? parse(draft) : Number.NaN;
		if (Number.isFinite(next)) setFlySpeed(next);
		setDraft(null);
	};
	const step = (deltaY) => {
		const next = stepFlySpeed(flySpeed, deltaY);
		setFlySpeed(next);
		if (open) setDraft(shown(next, 2));
	};

	// React's wheel listener is passive; a native one keeps the page still.
	useEffect(() => {
		const element = pill.current;
		const onWheel = (event) => {
			event.preventDefault();
			const next = stepFlySpeed(flySpeed, event.deltaY);
			setFlySpeed(next);
			if (open) setDraft(shown(next, 2));
		};
		element?.addEventListener("wheel", onWheel, { passive: false });
		return () => element?.removeEventListener("wheel", onWheel);
	}, [flySpeed, setFlySpeed, open]);
	useEffect(() => {
		if (!open) return;
		field.current?.focus();
		field.current?.select();
	}, [open]);
	// A press anywhere outside the pill and its field applies what is typed. The
	// stage's pickers stop presses on window capture (object-gizmo.jsx), which
	// keeps them from the document and from blurring the field, so this listens
	// on window capture too: stopPropagation spares listeners on the same target.
	useEffect(() => {
		if (draft === null) return undefined;
		const onPointerDown = (event) => {
			if (event.target instanceof Node && wrap.current?.contains(event.target)) return;
			const next = parse(draft);
			if (Number.isFinite(next)) setFlySpeed(next);
			setDraft(null);
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => window.removeEventListener("pointerdown", onPointerDown, true);
	}, [draft, setFlySpeed]);

	const onKeyDown = (event) => {
		if (event.key === "ArrowUp" || event.key === "ArrowDown") step(event.key === "ArrowUp" ? -1 : 1);
		else if (event.key === "Enter" || event.key === "Escape") {
			close(event.key === "Enter");
			pill.current?.focus();
		} else return;
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<div className="vp-menu-wrap vp-speed-wrap" ref={wrap} data-vp-menu="fly-speed">
			<button
				type="button"
				ref={pill}
				className="vp-pill vp-speed"
				data-testid="fly-speed"
				aria-haspopup="dialog"
				aria-expanded={open}
				title={ko("Fly speed — click to type or step it, scroll over it, or scroll while right-dragging", "비행 속도 — 클릭해 입력하거나 화살표로 조절, 위에서 스크롤, 또는 오른쪽 드래그 중 스크롤")}
				onMouseDown={(event) => open && event.preventDefault()}
				onClick={() => (open ? close(true) : setDraft(shown(flySpeed, 2)))}
			>
				<RailIcon name="speed" size={14} />
				<span className="vp-speed-value">{shown(flySpeed, 1)}×</span>
			</button>
			{open && (
				<div className="vp-menu vp-speed-menu" role="dialog" aria-label={ko("Fly speed", "비행 속도")}>
					<span className="vp-menu-label">{ko("Fly speed", "비행 속도")}</span>
					{/* The arrows keep the focus in the field, so its blur means "left". */}
					<div className="vp-speed-edit" onMouseDown={(event) => event.target !== field.current && event.preventDefault()}>
						<button type="button" data-step="slower" aria-label={ko("Slower", "느리게")} onClick={() => step(1)}>−</button>
						<input
							ref={field}
							data-testid="fly-speed-input"
							type="text"
							inputMode="decimal"
							aria-label={ko("Fly speed multiplier", "비행 속도 배율")}
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={onKeyDown}
							onBlur={(event) => !wrap.current?.contains(event.relatedTarget) && close(true)}
						/>
						<span aria-hidden="true">×</span>
						<button type="button" data-step="faster" aria-label={ko("Faster", "빠르게")} onClick={() => step(-1)}>+</button>
					</div>
				</div>
			)}
		</div>
	);
}
