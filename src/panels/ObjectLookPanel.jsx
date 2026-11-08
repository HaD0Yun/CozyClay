import { useContext, useEffect, useRef, useState } from "react";
import { AppContext } from "../app-context.js";
import { useStudioShell } from "../shell/studio-shell-context.js";
import Foldout from "./Foldout.jsx";
import { Field, Slider } from "../ui.jsx";
import { ko } from "../locale.js";
import { LIGHT_KIND, practicalShadows } from "../object-look.js";
import { TEXT_KIND } from "../text/text-record.js";

/**
 * Words, light and glow for the selected record: a text's words and letter
 * size, a practical light's type, colour, brightness, reach, cone, shadow and
 * flicker, and any record's glow. A drag or a typing run is one open
 * transaction (one undo); a switch is one atomic edit.
 */
export default function ObjectLookPanel() {
	const { selectedSceneObject: object, sceneObjects, beginSceneTransaction, endSceneTransaction } = useStudioShell();
	const app = useContext(AppContext), session = useRef(null);
	// The words box keeps its own draft while it is edited: the store refuses
	// blank words (normalizeText falls back to "Text"), so feeding it an empty
	// box would put "Text" straight back under the caret. Only non-blank words
	// are sent; leaving the box blank restores the last stored words.
	const [wordsDraft, setWordsDraft] = useState(null);
	const run = (...args) => {
		const receipt = app.bus.run(...args);
		if (receipt && !receipt.ok) app.notify(receipt.message);
		return receipt;
	};
	function commit() {
		const active = session.current;
		if (!active) return;
		session.current = null;
		endSceneTransaction(active.txId, { commit: true });
	}
	function drag(field, patch) {
		if (session.current?.field !== field) commit();
		if (!session.current) session.current = { field, txId: beginSceneTransaction({ owner: `inspector:${field}`, cancel: () => { session.current = null; } }) };
		run("run.update", { txId: session.current.txId, args: { id: object.id, patch } });
	}
	const set = (patch) => { commit(); run("object.update", { id: object.id, patch }); };
	useEffect(() => () => { commit(); setWordsDraft(null); }, [object?.id]);
	if (!object) return null;
	const light = object.renderer === LIGHT_KIND ? object.light : null;
	const glow = object.glow ?? null;
	const text = object.renderer === TEXT_KIND ? object.text : null;
	const capped = light?.shadow && practicalShadows(sceneObjects).capped.includes(object.id);
	const ends = { onPointerUp: commit, onPointerCancel: commit, onKeyUp: commit, onBlur: commit };
	const lightSlider = (field, label, min, max, step, unit = "") => (
		<Slider label={label} min={min} max={max} step={step} unit={unit} softMax value={light[field]} onChange={(value) => drag(`light.${field}`, { light: { [field]: value } })} />
	);
	return (
		<>
			{text && (
				<Foldout title={ko("Text", "텍스트")}>
					<Field label={ko("Words", "글자")}>
						<textarea rows={2} data-field="text-words" value={wordsDraft ?? text.value} onChange={(event) => { const value = event.target.value; setWordsDraft(value); if (value.trim()) drag("text.value", { text: { value } }); }} onBlur={() => { setWordsDraft(null); commit(); }} />
					</Field>
					<div {...ends}>
						<Slider label={ko("Letter height", "글자 높이")} min={0.02} max={3} step={0.01} unit=" m" softMax value={text.size} onChange={(value) => drag("text.size", { text: { size: value } })} />
						<Slider label={ko("Depth (0 = flat)", "두께 (0 = 평면)")} min={0} max={0.5} step={0.005} unit=" m" softMax value={text.depth} onChange={(value) => drag("text.depth", { text: { depth: value } })} />
						<Field label={ko("Align", "정렬")}>
							<select value={text.align} onChange={(event) => set({ text: { align: event.target.value } })}>
								<option value="left">{ko("Left", "왼쪽")}</option>
								<option value="center">{ko("Centre", "가운데")}</option>
								<option value="right">{ko("Right", "오른쪽")}</option>
							</select>
						</Field>
					</div>
				</Foldout>
			)}
			{light && (
				<Foldout title={ko("Light", "조명")}>
					<div {...ends}>
						<Field label={ko("Type", "종류")}>
							<select value={light.type} onChange={(event) => set({ light: { type: event.target.value } })}>
								<option value="point">{ko("Point", "점 조명")}</option>
								<option value="spot">{ko("Spot", "스포트")}</option>
							</select>
						</Field>
						<Field label={ko("Colour", "색")}>
							<input type="color" value={light.color} onChange={(event) => drag("light.color", { light: { color: event.target.value } })} />
						</Field>
						{lightSlider("intensity", ko("Intensity (cd)", "밝기 (cd)"), 0, 100, 0.05)}
						{lightSlider("range", ko("Range (0 = none)", "범위 (0 = 없음)"), 0, 30, 0.1, " m")}
						{light.type === "spot" && lightSlider("angle", ko("Cone angle", "원뿔 각도"), 1, 89, 1, "°")}
						{light.type === "spot" && lightSlider("softness", ko("Edge softness", "가장자리 부드럽기"), 0, 1, 0.05)}
						{lightSlider("flicker", ko("Flicker", "깜빡임"), 0, 1, 0.05)}
						<label className="check details-toggle-row">
							<span>{capped ? ko("Shadow (off: only 2 lights cast)", "그림자 (꺼짐: 2개까지만)") : ko("Shadow", "그림자")}</span>
							<input type="checkbox" checked={light.shadow} onChange={(event) => set({ light: { shadow: event.target.checked } })} />
						</label>
					</div>
				</Foldout>
			)}
			<Foldout title={ko("Glow", "발광")} defaultOpen={Boolean(glow)}>
				<div {...ends}>
					<label className="check details-toggle-row">
						<span>{ko("Glows (lit by itself)", "스스로 빛남")}</span>
						<input type="checkbox" checked={Boolean(glow)} onChange={(event) => set({ glow: event.target.checked ? {} : null })} />
					</label>
					{glow && (
						<>
							<Field label={ko("Colour", "색")}>
								<input type="color" value={glow.color} onChange={(event) => drag("glow.color", { glow: { color: event.target.value } })} />
							</Field>
							<Slider label={ko("Intensity", "세기")} min={0} max={20} step={0.1} value={glow.intensity} onChange={(value) => drag("glow.intensity", { glow: { intensity: value } })} />
							<Slider label={ko("Halo (× size)", "후광 (× 크기)")} min={0} max={4} step={0.05} value={glow.halo} onChange={(value) => drag("glow.halo", { glow: { halo: value } })} />
						</>
					)}
				</div>
			</Foldout>
		</>
	);
}
