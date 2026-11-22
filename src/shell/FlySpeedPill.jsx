import { useEffect, useRef, useState } from "react";
import { ko } from "../locale.js";
import { clampFlySpeed, stepFlySpeed } from "../fly-speed.js";
import RailIcon from "./RailIcon.jsx";

const shown = (value, digits) => String(Number(value.toFixed(digits)));
// Empty text is not a number: Number("") is 0, which would clamp to the slowest speed.
const parse = (text) => {
	const number = String(text).replace(/[×x]\s*$/i, "").trim().replace(",", ".");
	return number === "" ? Number.NaN : clampFlySpeed(number);
};

/** The viewport's fly speed readout. A click opens a field beside it: type a
 * number (Enter or a click outside applies, Escape cancels) or step it with
 * the arrows; the wheel over the pill steps it too. Every way uses the same
 * range and 10 % step as the wheel during a right-drag (fly-speed.js), and
 * writes the one speed FlyControls flies with. */
export default function FlySpeedPill({ flySpeed, setFlySpeed }) {
	const [open, setOpen] = useState(false);
	// null while the field follows the speed; the text once the user edits it.
	const [typed, setTyped] = useState(null);
	const wrap = useRef(null);
	const pill = useRef(null);
	const field = useRef(null);
	// The handlers read this, not a render's values: two of them can run before
	// the next render (two wheel notches; a key that closes and the blur it causes).
	const live = useRef({ open: false, typed: null, byKey: false });
	const type = (text) => { live.current.typed = text; setTyped(text); };
	const show = (next) => { live.current.open = next; setOpen(next); type(null); };

	const close = (commit) => {
		const { open: wasOpen, typed: text } = live.current;
		if (!wasOpen) return;
		show(false);
		const next = commit && text !== null ? parse(text) : Number.NaN;
		if (Number.isFinite(next)) setFlySpeed(next);
	};
	// A step starts from the typed number when there is one, else from the speed
	// itself, as an updater: no notch is lost to a value a render has not delivered.
	const step = (deltaY) => {
		const from = live.current.typed === null ? Number.NaN : parse(live.current.typed);
		setFlySpeed(Number.isFinite(from) ? stepFlySpeed(from, deltaY) : (speed) => stepFlySpeed(speed, deltaY));
		type(null);
	};
	// The two window and element listeners below stay attached; they call the latest handlers through this.
	const handlers = useRef({ close, step });
	useEffect(() => { handlers.current = { close, step }; });

	// React's wheel listener is passive; a native one keeps the page still.
	useEffect(() => {
		const element = pill.current;
		const onWheel = (event) => {
			event.preventDefault();
			handlers.current.step(event.deltaY);
		};
		element?.addEventListener("wheel", onWheel, { passive: false });
		return () => element?.removeEventListener("wheel", onWheel);
	}, []);
	// The field takes the keys only where it can be seen and pressed. The narrow
	// shell's rail clips every menu that opens beside it (narrow.css), and a
	// hidden field would swallow the stage's shortcuts; there the click does nothing
	// and, like the readout it was, the pill does not keep a pointer's focus.
	useEffect(() => {
		const input = open ? field.current : null;
		if (!input) return;
		const box = input.getBoundingClientRect();
		if (document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === input) {
			input.focus();
			input.select();
			return;
		}
		handlers.current.close(false);
		if (!live.current.byKey) pill.current?.blur();
	}, [open]);
	// A press anywhere outside the pill and its field applies what is typed. The
	// stage's pickers stop presses on window capture (object-gizmo.jsx), which
	// keeps them from the document and from blurring the field, so this listens
	// on window capture too: stopPropagation spares listeners on the same target.
	useEffect(() => {
		if (!open) return undefined;
		const onPointerDown = (event) => {
			if (event.target instanceof Node && wrap.current?.contains(event.target)) return;
			handlers.current.close(true);
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => window.removeEventListener("pointerdown", onPointerDown, true);
	}, [open]);

	const onKeyDown = (event) => {
		if (!live.current.open) return;
		const inField = event.target === field.current;
		if (inField && (event.key === "ArrowUp" || event.key === "ArrowDown")) step(event.key === "ArrowUp" ? -1 : 1);
		else if (event.key === "Escape" || (inField && event.key === "Enter")) {
			// A keyboard user goes back to the pill. A pointer user's focus leaves the
			// rail: a focused button owns Space, so the pill would open again instead
			// of the playback toggle (timeline.jsx skips its keys on a focused button).
			const toPill = live.current.byKey;
			close(event.key === "Enter");
			if (toPill) pill.current?.focus();
			else if (document.activeElement instanceof HTMLElement && wrap.current?.contains(document.activeElement)) document.activeElement.blur();
		} else return;
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<div
			className="vp-menu-wrap vp-speed-wrap"
			ref={wrap}
			data-vp-menu="fly-speed"
			onKeyDown={onKeyDown}
			onBlur={(event) => !wrap.current?.contains(event.relatedTarget) && close(true)}
		>
			<button
				type="button"
				ref={pill}
				className="vp-pill vp-speed"
				data-testid="fly-speed"
				aria-haspopup="dialog"
				aria-expanded={open}
				title={ko("Fly speed — click to type or step it, scroll over it, or scroll while right-dragging", "비행 속도 — 클릭해 입력하거나 화살표로 조절, 위에서 스크롤, 또는 오른쪽 드래그 중 스크롤")}
				onMouseDown={(event) => open && event.preventDefault()}
				onClick={(event) => {
					if (live.current.open) return close(true);
					live.current.byKey = event.detail === 0; // a keyboard activation has no click count
					return show(true);
				}}
			>
				<RailIcon name="speed" size={14} />
				<span className="vp-speed-value">{shown(flySpeed, 1)}×</span>
			</button>
			{open && (
				<div className="vp-menu vp-speed-menu" role="dialog" aria-label={ko("Fly speed", "비행 속도")}>
					<span className="vp-menu-label">{ko("Fly speed", "비행 속도")}</span>
					{/* The arrows keep the focus in the field, so a blur means the focus left the pill. */}
					<div className="vp-speed-edit" onMouseDown={(event) => event.target !== field.current && event.preventDefault()}>
						<button type="button" data-step="slower" aria-label={ko("Slower", "느리게")} onClick={() => step(1)}>−</button>
						<input
							ref={field}
							data-testid="fly-speed-input"
							type="text"
							inputMode="decimal"
							aria-label={ko("Fly speed multiplier", "비행 속도 배율")}
							value={typed ?? shown(flySpeed, 2)}
							onChange={(event) => type(event.target.value)}
						/>
						<span aria-hidden="true">×</span>
						<button type="button" data-step="faster" aria-label={ko("Faster", "빠르게")} onClick={() => step(-1)}>+</button>
					</div>
				</div>
			)}
		</div>
	);
}
