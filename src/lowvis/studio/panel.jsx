// The lowvis request panel of the Studio (prototype, shown with ?lowvis[=<port>] in the URL): type a request, the pi
// harness (tools/lowvis/pi/try.mjs on that port, default 5201) writes the scene, and the finished clip plays on the
// Studio stage (layer.jsx). The panel also lists earlier tries; a finished one loads with a click.
import { useEffect, useRef, useState } from "react";
import { ko } from "../../locale.js";
import { clipUsable } from "../viewer/scene.js";

/** The try server's port when the page asks for the lowvis panel, else null. */
export function lowvisPort(search = globalThis.location?.search ?? "") {
	const params = new URLSearchParams(search);
	if (!params.has("lowvis")) return null;
	const port = Number(params.get("lowvis"));
	return Number.isInteger(port) && port > 1023 && port < 65536 ? port : 5201;
}

async function loadClip(name) {
	const res = await fetch(`${import.meta.env.BASE_URL}lowvis/clips/pi/${encodeURIComponent(name)}.json`, { cache: "no-store" });
	if (!res.ok) return null;
	try {
		const clip = JSON.parse(await res.text());
		return clipUsable(clip) ? clip : null;
	} catch {
		return null;
	}
}

const S = {
	// inside the open stage's top-left corner (the shell's own insets; 0 where the shell does not set them)
	panel: { position: "absolute", left: "calc(var(--shell-center-left, 0px) + 12px)", top: "calc(var(--shell-stage-top, 0px) + 12px)", zIndex: 40, width: 300, maxHeight: "calc(100% - var(--shell-stage-top, 0px) - var(--shell-center-bottom, 0px) - 24px)", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 6, padding: 10, borderRadius: 10, background: "rgba(28, 28, 30, 0.92)", color: "#ececea", font: "13px/1.45 -apple-system, 'Apple SD Gothic Neo', sans-serif", boxShadow: "0 6px 24px rgba(0,0,0,.35)" },
	head: { display: "flex", alignItems: "center", gap: 6, fontWeight: 650 },
	grow: { flex: 1 },
	text: { font: "inherit", minHeight: 54, resize: "vertical", padding: "6px 8px", borderRadius: 6, border: "1px solid #55585c", background: "#1b1c1e", color: "inherit" },
	button: { font: "inherit", padding: "4px 10px", borderRadius: 6, border: "1px solid #6f8fb0", background: "#3b6591", color: "#fff", cursor: "pointer" },
	quiet: { font: "inherit", padding: "2px 8px", borderRadius: 6, border: "1px solid #55585c", background: "transparent", color: "inherit", cursor: "pointer" },
	list: { listStyle: "none", margin: 0, padding: 0, overflowY: "auto", minHeight: 0, maxHeight: 170, display: "flex", flexDirection: "column", gap: 4 },
	item: on => ({ padding: "5px 8px", borderRadius: 6, border: `1px solid ${on ? "#8db4dc" : "#45484c"}`, background: on ? "#22364a" : "#232527", cursor: "pointer" }),
	mute: { opacity: 0.7, fontSize: 12 },
	check: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" },
	note: { whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 96, flexShrink: 0, overflowY: "auto", padding: "5px 8px", borderRadius: 6, background: "#232527" },
};

/**
 * cast: whether the loaded clip's characters are Studio cast members; block: whether rig characters wear the block look.
 * onClip({ name, request, clip } | null, { cast }) loads or clears a clip; onBlock(on) switches the look.
 */
export function LowvisPanel({ port, loaded, cast, block, onClip, onBlock }) {
	const base = `http://127.0.0.1:${port}`;
	const [tries, setTries] = useState([]), [error, setError] = useState(null), [open, setOpen] = useState(true), [text, setText] = useState(""), [busy, setBusy] = useState(false);
	const [asCast, setAsCast] = useState(true);
	const wanted = useRef(null), onClipRef = useRef(onClip), asCastRef = useRef(asCast), current = useRef(null);
	useEffect(() => { onClipRef.current = onClip; asCastRef.current = asCast; });

	async function show(entry, options = { cast: asCastRef.current }) {
		const clip = entry?.state === "done" ? await loadClip(entry.name) : null;
		if (clip) { current.current = entry; onClipRef.current({ name: entry.name, request: entry.request, clip }, options); }
		return !!clip;
	}

	useEffect(() => {
		let live = true;
		async function refresh() {
			try {
				const list = await (await fetch(`${base}/tries`)).json();
				if (!live) return;
				setTries(list);
				setError(null);
				// the run this panel started plays as soon as it is finished
				const mine = list.find(entry => entry.name === wanted.current);
				if (mine && mine.state !== "running") { wanted.current = null; show(mine); }
			} catch {
				if (live) setError(ko(`The lowvis server on port ${port} does not answer.`, `포트 ${port}의 lowvis 서버가 응답하지 않습니다.`));
			}
		}
		refresh();
		const timer = setInterval(refresh, 2000);
		return () => { live = false; clearInterval(timer); };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [base]);

	async function submit(event) {
		event.preventDefault();
		const request = text.trim();
		if (!request || busy) return;
		setBusy(true);
		try {
			const answer = await (await fetch(`${base}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request }) })).json();
			if (answer.name) { wanted.current = answer.name; setText(""); }
		} catch {
			setError(ko(`The lowvis server on port ${port} does not answer.`, `포트 ${port}의 lowvis 서버가 응답하지 않습니다.`));
		}
		setBusy(false);
	}

	const shown = tries.find(entry => entry.name === loaded);
	const label = entry => entry.state === "running" ? ko(`writing · ${entry.seconds}s`, `만드는 중 · ${entry.seconds}초`)
		: entry.state === "done" ? ko(`done · ${entry.seconds}s · ${entry.compiles} compiles`, `완성 · ${entry.seconds}초 · 지시문 ${entry.compiles}번`)
		: entry.state === "failed" ? ko("failed", "실패") : "";
	return (
		<div style={S.panel} data-testid="lowvis-panel" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
			<div style={S.head}>
				<span>lowvis</span>
				<span style={{ ...S.mute, ...S.grow }}>{ko("block figure, prototype", "블록 인형, 시험판")}</span>
				{loaded && <button type="button" style={S.quiet} onClick={() => onClip(null)}>{ko("Clear", "비우기")}</button>}
				<button type="button" style={S.quiet} onClick={() => setOpen(value => !value)}>{open ? ko("Fold", "접기") : ko("Open", "펴기")}</button>
			</div>
			{open && (
				<>
					<form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
						<textarea style={S.text} value={text} placeholder={ko("e.g. walk to the chair, sit, then stand up", "예: 의자로 걸어가서 앉았다가 일어나기")}
							onChange={event => setText(event.target.value)}
							onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event); }} />
						<button type="submit" style={{ ...S.button, opacity: busy || !text.trim() ? 0.5 : 1 }} disabled={busy || !text.trim()}>{ko("Make", "만들기")}</button>
					</form>
					<label style={S.check}>
						<input type="checkbox" checked={asCast} onChange={event => { setAsCast(event.target.checked); if (loaded && current.current) show(current.current, { cast: event.target.checked }); }} />
						{ko("As Studio characters (select, move, save)", "Studio 캐릭터로 넣기 (선택·이동·저장)")}
					</label>
					<label style={S.check}>
						<input type="checkbox" checked={block} onChange={event => onBlock(event.target.checked)} />
						{ko("Block figure look", "블록 인형 모습")}
					</label>
					{loaded && asCast && !cast && <div style={{ ...S.note, color: "#ffb3a8" }}>{ko("The Studio refused the characters; the clip is drawn as a layer.", "Studio가 캐릭터를 받지 않아 층으로만 그렸습니다.")}</div>}
					{error && <div style={{ ...S.note, color: "#ffb3a8" }}>{error}</div>}
					{shown && (shown.report || shown.missing) && (
						<div style={S.note}>{shown.report}{shown.missing ? `\n\n${ko("Not done", "못 한 것")}: ${shown.missing}` : ""}</div>
					)}
					<ul style={S.list}>
						{tries.map(entry => (
							<li key={entry.name} style={S.item(entry.name === loaded)} onClick={() => show(entry)}>
								<div>{entry.request ?? entry.name}</div>
								<div style={S.mute}>{label(entry)}</div>
							</li>
						))}
					</ul>
				</>
			)}
		</div>
	);
}
