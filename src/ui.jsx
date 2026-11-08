import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createScrubGesture } from "./ui-scrub.js";
import { isImeComposing } from "./ime.js";
import { usePopover } from "./popover.js";

// Custom dropdown, structurally matched to the reference (`.dropdown`,
// `dd-caret`, `dropdown-menu`, `dropdown-item`, `dd-check`) with the keyboard
// support the reference lacks. `highlighted` marks the arrow-key cursor;
// the selection itself is `active`.
//
// The menu is portaled to document.body and fixed-positioned from the
// trigger rect: inspector foldouts are `.card { overflow: hidden }` inside a
// scroll pane, so an in-place absolute menu gets clipped to the card's
// height (the pose foldout is ~70 px tall against a ~290 px menu). Scrolling
// or resizing while open closes the menu instead of chasing the trigger.
export function Dropdown({ value, options, onChange, ariaLabel, menuClassName = "" }) {
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(-1);
	const rootRef = useRef(null);
	const triggerRef = useRef(null);
	const menuRef = useRef(null);
	const [menuBox, setMenuBox] = useState(null);
	const uid = useId();
	const listId = `${uid}-list`;
	const selectedIndex = options.findIndex((o) => o.value === value);
	const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

	// Close on any mousedown outside the dropdown (the portaled menu is not
	// inside rootRef, so it is checked separately) and when another shell
	// popover opens. Effect cleanup also covers unmounting while open.
	usePopover(open, () => setOpen(false), [rootRef, menuRef]);

	// Position the portaled menu from the trigger: below when it fits, above
	// otherwise, height capped to the free space. Scroll and resize close the
	// menu — native selects behave the same and it beats a stale position.
	useLayoutEffect(() => {
		if (!open) {
			setMenuBox(null);
			return;
		}
		const rect = triggerRef.current?.getBoundingClientRect();
		if (!rect) return;
		const margin = 8;
		const below = window.innerHeight - rect.bottom - margin;
		const above = rect.top - margin;
		const up = below < 160 && above > below;
		setMenuBox({
			left: rect.left,
			width: rect.width,
			maxHeight: Math.max(120, Math.min(288, up ? above : below)),
			...(up ? { bottom: window.innerHeight - rect.top + 2 } : { top: rect.bottom + 2 }),
		});
		const onAway = (e) => {
			// Scrolling inside the menu itself must not dismiss it.
			if (e.type === "scroll" && menuRef.current?.contains(e.target)) return;
			setOpen(false);
		};
		window.addEventListener("resize", onAway);
		window.addEventListener("scroll", onAway, true);
		return () => {
			window.removeEventListener("resize", onAway);
			window.removeEventListener("scroll", onAway, true);
		};
	}, [open]);

	// Keyboard navigation starts from the current selection.
	useEffect(() => {
		if (open) setHighlight(selectedIndex);
	}, [open, selectedIndex]);

	const close = () => setOpen(false);

	const moveHighlight = (dir) => {
		if (options.length === 0) return;
		setHighlight((h) =>
			h < 0
				? dir > 0
					? 0
					: options.length - 1
				: (h + dir + options.length) % options.length,
		);
	};

	const onKeyDown = (e) => {
		if (!open) return;
		if (e.key === "Escape") {
			e.preventDefault();
			close();
			triggerRef.current?.focus();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			moveHighlight(1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			moveHighlight(-1);
		} else if (e.key === "Enter" && highlight >= 0 && highlight < options.length) {
			e.preventDefault();
			onChange(options[highlight].value);
			close();
		}
	};

	return (
		<div className={"dropdown" + (open ? " open" : "")} ref={rootRef} onKeyDown={onKeyDown}>
			<button
				type="button"
				className="trigger"
				ref={triggerRef}
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-controls={listId}
				aria-label={ariaLabel}
				onClick={() => setOpen((o) => !o)}
			>
				<span>{selected ? selected.label : ""}</span>
				<svg
					className="dd-caret"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M6 9l6 6 6-6" />
				</svg>
			</button>
			{open && menuBox && createPortal(
				<div
					className={"dropdown-menu " + menuClassName}
					ref={menuRef}
					id={listId}
					role="listbox"
					aria-activedescendant={highlight >= 0 && highlight < options.length ? `${uid}-opt-${highlight}` : undefined}
					style={{ position: "fixed", zIndex: "var(--z-popover, 90)", ...menuBox, overflowY: "auto" }}
					onKeyDown={onKeyDown}
				>
					{options.map((opt, i) => (
						<button
							type="button"
							key={opt.value}
							id={`${uid}-opt-${i}`}
							role="option"
							aria-selected={opt.value === value}
							className={
								"dropdown-item" +
								(opt.value === value ? " active" : "") +
								(i === highlight ? " highlighted" : "")
							}
							onClick={() => {
								onChange(opt.value);
								close();
							}}
						>
							<span>{opt.label}</span>
							{opt.value === value && (
								<svg
									className="dd-check"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M20 6L9 17l-5-5" />
								</svg>
							)}
						</button>
					))}
				</div>,
				document.body,
			)}
		</div>
	);
}

// Auto-dismissing toast; the timer restarts whenever the message (or
// duration) changes and is always cleared on unmount.
export function Toast({ message, onDone, duration = 2200 }) {
	useEffect(() => {
		if (!message) return;
		const timer = setTimeout(onDone, duration);
		return () => clearTimeout(timer);
		// onDone deliberately excluded: callers pass inline callbacks and the
		// timer must survive parent re-renders within one message lifetime.
	}, [message, duration]);
	if (!message) return null;
	return <div className="toast">{message}</div>;
}

// Range slider with the reference's filled-track gradient. `value` may be a
// raw float (e.g. from drag interactions), so it is clamped and the label is
// rounded to the slider's own step precision.
//
// `softMax` keeps the track's useful range but treats `max` as a soft stop:
// the compact head scrubs like a NumberField axis (pointer drag, Shift 10x,
// Alt 0.1x), floored at `min` and unbounded above, and the readout shows the
// true stored value even past `max`. The track itself still writes only
// in-range values and the fill simply saturates.
export function Slider({ label, min, max, step, value, unit = "", onChange, compact, softMax }) {
	const scrubRef = useRef(null);
	const floored = Math.max(min, value);
	const clamped = Math.min(max, floored);
	const percent = Math.max(0, Math.min(100, ((clamped - min) / (max - min)) * 100));
	const decimals = (String(step).split(".")[1] || "").length;
	const snapped = Math.round((clamped - min) / step) * step + min;
	const shown = softMax ? floored : snapped;
	const text = String(decimals > 0 ? Number(shown.toFixed(decimals)) : Math.round(shown));
	const onScrubDown = (e) => {
		e.preventDefault();
		scrubRef.current = { x: e.clientX, base: floored };
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const onScrubMove = (e) => {
		const drag = scrubRef.current;
		if (!drag) return;
		const multiplier = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
		onChange(Math.max(min, drag.base + (e.clientX - drag.x) * step * multiplier));
	};
	const onScrubEnd = (e) => {
		if (!scrubRef.current) return;
		scrubRef.current = null;
		if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
	};
	const scrubProps = softMax
		? { onPointerDown: onScrubDown, onPointerMove: onScrubMove, onPointerUp: onScrubEnd, onPointerCancel: onScrubEnd }
		: null;
	const input = (
		<input
			type="range"
			min={min}
			max={max}
			step={step}
			value={clamped}
			style={{ background: `linear-gradient(to right, var(--accent) ${percent}%, var(--track) ${percent}%)` }}
			onChange={(e) => onChange(parseFloat(e.target.value))}
		/>
	);
	if (compact) {
		return (
			<div className="cslider v2-details-compact-slider">
				<div className={"cslider-head" + (softMax ? " scrub" : "")} {...scrubProps}>
					<span>{label}</span>
					<span className="val">
						{text}
						{unit}
					</span>
				</div>
				{input}
			</div>
		);
	}
	return (
		<div className="row v2-details-row">
			<span className="v2-details-row-label">{label}</span>
			{input}
			<span className="val">
				{text}
				{unit}
			</span>
		</div>
	);
}

export function Field({ label, children }) {
	return (
		<div className="field v2-details-field">
			<label>{label}</label>
			{children}
		</div>
	);
}
export function NumberField({ label, value, step, precision = 2, scrubRange, onChange, onScrubStart, onScrubEnd, title, disabled = false }) {
	const [focused, setFocused] = useState(false);
	const [draft, setDraft] = useState(null);
	// The draft must be readable synchronously: blur() fires the commit
	// handler before React re-renders, so state alone would commit the
	// pre-Escape value.
	const draftRef = useRef(null);
	// Freshest committed prop for a drag baseline, even while a parent
	// re-render from the previous commit is still pending.
	const valueRef = useRef(value);
	const inputRef = useRef(null);
	// The scrub lifecycle's window listeners are registered once (Escape,
	// blur), so the freshest end callback is mirrored like `valueRef`.
	const scrubEndRef = useRef(onScrubEnd);
	scrubEndRef.current = onScrubEnd;
	// `{ gesture, scrubbing, token }` of the press, null while no button is
	// down. `scrubbing` marks the press that has travelled far enough to be a
	// drag; `token` is the open store transaction, null until then (a plain
	// click must not open one) or when no scrub props exist.
	const dragRef = useRef(null);

	valueRef.current = value;

	const setDraftValue = (text) => {
		draftRef.current = text;
		setDraft(text);
	};

	// Push the draft to the store when it parses; either way clear it so the
	// field falls back to the incoming prop. Returns the parsed number (or
	// null) so a drag can baseline from what was just committed.
	const commitDraft = () => {
		const parsed = parseFloat(draftRef.current);
		const ok = Number.isFinite(parsed);
		if (ok) onChange(parsed);
		setDraftValue(null);
		return ok ? parsed : null;
	};

	// Round to `precision` decimals, then let String() drop trailing zeros:
	// 1.50 reads 1.5, 45.0 reads 45.
	const formatValue = (n) => String(Number(n.toFixed(precision)));

	const onFocus = (e) => {
		setFocused(true);
		// Start from the formatted number so typing replaces the whole value.
		setDraftValue(formatValue(value));
		e.target.select();
	};

	const onBlur = () => {
		commitDraft();
		setFocused(false);
	};

	const onKeyDown = (e) => {
		if (e.key === "Enter" && !isImeComposing(e)) {
			e.preventDefault();
			commitDraft();
			// Keep focus and select the committed value so the next keystroke
			// replaces it, like Unity's inspector.
			e.currentTarget.select();
		} else if (e.key === "Escape") {
			e.preventDefault();
			// Clear the ref first: the blur below commits, and a cleared
			// draft parses to NaN, so the revert survives.
			setDraftValue(null);
			inputRef.current?.blur();
		}
	};

	// Blender/Unity scrubbing: press anywhere on the field — badge OR number —
	// and drag left/right to change the value. The press does not commit to
	// anything yet: under the travel threshold it is still a click that focuses
	// the input for typing (issue #87 — users aim at the number, and the badge
	// alone was a 15 px hotspot nobody found). Sensitivity is a fixed-travel
	// rate (src/ui-scrub.js), not pixels * step, so every field feels the same.
	const onFieldPointerDown = (e) => {
		if (e.button !== 0 || disabled) return;
		// A press inside an already-focused input is text editing (caret
		// placement, drag-select), not a scrub — leave it alone.
		if (focused && e.target === inputRef.current) return;
		// A press on the badge while the number is being typed still commits what
		// was typed, so the drag baselines from what the user just wrote.
		const base = draftRef.current !== null ? commitDraft() : null;
		dragRef.current = {
			gesture: createScrubGesture({ x: e.clientX, value: base ?? valueRef.current, step, precision, scrubRange }),
			scrubbing: false,
			token: null,
		};
	};

	const onFieldPointerMove = (e) => {
		const drag = dragRef.current;
		if (!drag) return;
		const next = drag.gesture.move(e.clientX, { shiftKey: e.shiftKey, altKey: e.altKey });
		if (next === null) return;
		if (!drag.scrubbing) {
			// First armed move: the press has become a drag. Take the focus back
			// from the input (the press already focused it) so the drag is not
			// typing into a selected number — with the draft dropped first, so the
			// blur commits nothing outside the transaction.
			e.preventDefault();
			drag.scrubbing = true;
			if (document.activeElement === inputRef.current) {
				setDraftValue(null);
				inputRef.current.blur();
			}
			// A scrub is one store transaction: begin before any apply so the whole
			// drag lands as a single undo entry. The teardown is registered as the
			// store's cancel so a settle leaves the scrub inert without this
			// component closing the token itself.
			drag.token = onScrubStart?.({ owner: "field", cancel: () => teardownScrub(drag) }) ?? null;
		}
		onChange(next, drag.token);
	};
	// The window listeners below are registered once, so they read the freshest
	// move handler the same way `scrubEndRef` mirrors the end callback.
	const scrubMoveRef = useRef(onFieldPointerMove);
	scrubMoveRef.current = onFieldPointerMove;

	// Drop the scrub ref. Shared by every close path AND the store's cancel;
	// never closes the transaction itself — the caller decides the commit value.
	const teardownScrub = (drag) => {
		if (!drag || dragRef.current !== drag) return;
		dragRef.current = null;
	};

	// A press that never armed is a plain click: drop it without touching the
	// store, so no empty transaction and no history entry for a focus.
	const closeScrub = (commit) => {
		const drag = dragRef.current;
		if (!drag) return;
		teardownScrub(drag);
		if (!drag.scrubbing) return;
		scrubEndRef.current?.(drag.token, { commit });
	};

	const endFieldDrag = () => closeScrub(true);

	useEffect(() => {
		// While a scrub is live, Escape cancels the whole drag. It must run in
		// the capture phase and stop propagation so the same press cannot also
		// reach the input's revert-and-blur handler or App's Escape handler.
		// Window blur commits like pointerup: travel already applied is real
		// work, not intent to discard (plan §6.3).
		const onEscape = (event) => {
			if (event.key !== "Escape") return;
			if (!dragRef.current?.scrubbing) return;
			event.stopPropagation();
			closeScrub(false);
		};
		const onBlur = () => closeScrub(true);
		// The drag lives on the window, not on the field: a 40 px wide number is
		// left behind within a few pixels of travel, and pointer capture cannot
		// be claimed mid-gesture reliably — the same window-listener shape the
		// timeline's curve drags use.
		const onMove = (event) => {
			if (!dragRef.current) return;
			scrubMoveRef.current(event);
		};
		const onUp = () => closeScrub(true);
		window.addEventListener("keydown", onEscape, true);
		window.addEventListener("blur", onBlur);
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		window.addEventListener("pointercancel", onUp, true);
		return () => {
			window.removeEventListener("keydown", onEscape, true);
			window.removeEventListener("blur", onBlur);
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			window.removeEventListener("pointercancel", onUp, true);
			closeScrub(true);
		};
	}, []);

	const display = focused && draft !== null ? draft : formatValue(value);

	return (
		<span
			className={`number-field v2-details-number-field${focused ? " editing" : ""}${disabled ? " disabled" : ""}`}
			title={title}
			onPointerDown={onFieldPointerDown}
			onPointerUp={endFieldDrag}
			onPointerCancel={endFieldDrag}
		>
			<span className="axis" data-axis={label}>{label}</span>
			<input
				ref={inputRef}
				type="text"
				inputMode="decimal"
				value={display}
				disabled={disabled}
				onFocus={onFocus}
				onBlur={onBlur}
				onChange={(e) => setDraftValue(e.target.value)}
				onKeyDown={onKeyDown}
			/>
		</span>
	);
}

// One Unity-style transform row: a row label plus one scrubbable NumberField
// per axis. `fields` entries are `{ axis, value, step, precision, onChange }`.
export function Vector3Row({ label, fields }) {
	return (
		<div className="vec3-row v2-details-transform-row">
			<span className="vec3-label v2-details-transform-label">{label}</span>
			{fields.map((field) => (
				<NumberField
					key={field.axis}
					label={field.axis}
					value={field.value}
					step={field.step}
					precision={field.precision}
					scrubRange={field.scrubRange}
					onChange={field.onChange}
					onScrubStart={field.onScrubStart}
					onScrubEnd={field.onScrubEnd} disabled={field.disabled} title={field.title}
				/>
			))}
		</div>
	);
}
