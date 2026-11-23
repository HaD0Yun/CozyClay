import { useContext, useEffect, useRef, useState } from "react";
import { AppContext } from "../app-context.js";
import { useStudioShell } from "../shell/studio-shell-context.js";
import Foldout from "./Foldout.jsx";
import { Field, Slider } from "../ui.jsx";
import { ko } from "../locale.js";
import { LIGHT_KIND, PRACTICAL_LIGHT_CAP, PRACTICAL_SHADOW_CAP, practicalShadows } from "../object-look.js";
import { TEXT_KIND } from "../text/text-record.js";
import { isProxyFigure } from "../scenes.js";

/** A light's aim as the Aim select's value: "down", "point" or "id:<id>". */
const aimValue = (aim) => (!aim ? "down" : aim.id === undefined ? "point" : `id:${aim.id}`);
const aimFromValue = (value, aim) => (value === "down" ? null : value === "point" ? aim : { id: value.slice(3) });
/** What a light can follow: the cast's rig characters (a proxy figure has no hips to follow), then the records that are
 * not lights; an aimed-at id the light cannot find stays listed. */
function aimTargets(characters, objects, ownId, aim) {
	const targets = [...characters.filter((c) => !isProxyFigure(c)).map((c) => ({ id: c.id, label: c.subject || c.id })),
		...objects.filter((o) => o.id !== ownId && o.renderer !== LIGHT_KIND).map((o) => ({ id: o.id, label: o.name || o.id }))];
	if (aim?.id !== undefined && !targets.some((t) => t.id === aim.id)) targets.push({ id: aim.id, label: `${aim.id} (${ko("not found", "찾을 수 없음")})` });
	return targets;
}

/**
 * Words, light and glow for the selected record: a text's words and letter
 * size, a practical light's type, colour, brightness, reach, cone, shadow and
 * flicker, and any record's glow. A drag or a typing run is one open
 * transaction (one undo); a switch is one atomic edit.
 */
export default function ObjectLookPanel() {
	const { selectedSceneObject: object, sceneObjects, characters = [], beginSceneTransaction, endSceneTransaction } = useStudioShell();
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
	const caps = light ? practicalShadows(sceneObjects) : null, capped = light?.shadow && caps.capped.includes(object.id), unlit = Boolean(light) && caps.unlit.includes(object.id);
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
						{unlit && <p className="inspector-hint" data-field="light-capped">{ko(`Not drawn: only the first ${PRACTICAL_LIGHT_CAP} lights light the scene`, `그려지지 않음: 처음 ${PRACTICAL_LIGHT_CAP}개 조명만 장면을 비춥니다`)}</p>}
						<Field label={ko("Type", "종류")}>
							<select data-field="light-type" value={light.type} onChange={(event) => set({ light: { type: event.target.value } })}>
								<option value="point">{ko("Point", "점 조명")}</option>
								<option value="spot">{ko("Spot", "스포트")}</option>
								<option value="directional">{ko("Directional", "방향")}</option>
							</select>
						</Field>
						{light.type !== "point" && (
							<Field label={ko("Aim at", "겨냥")}>
								<select data-field="light-aim" value={aimValue(light.aim)} onChange={(event) => set({ light: { aim: aimFromValue(event.target.value, light.aim) } })}>
									<option value="down">{ko("Straight down its own axis", "자기 축 아래로")}</option>
									{light.aim && light.aim.id === undefined && <option value="point">{`${ko("At point", "지점")} ${["x", "y", "z"].map((axis) => light.aim[axis].toFixed(1)).join(", ")}`}</option>}
									{aimTargets(characters, sceneObjects, object.id, light.aim).map(({ id, label }) => <option key={id} value={`id:${id}`}>{label}</option>)}
								</select>
							</Field>
						)}
						<Field label={ko("Colour", "색")}>
							<input type="color" value={light.color} onChange={(event) => drag("light.color", { light: { color: event.target.value } })} />
						</Field>
						{light.type === "directional"
							? lightSlider("intensity", ko("Intensity (key light scale)", "밝기 (키 조명 기준)"), 0, 4, 0.05)
							: lightSlider("intensity", ko("Intensity (cd)", "밝기 (cd)"), 0, 100, 0.05)}
						{light.type !== "directional" && lightSlider("range", ko("Range (0 = none)", "범위 (0 = 없음)"), 0, 30, 0.1, " m")}
						{light.type === "spot" && lightSlider("angle", ko("Cone angle", "원뿔 각도"), 1, 89, 1, "°")}
						{light.type === "spot" && lightSlider("softness", ko("Edge softness", "가장자리 부드럽기"), 0, 1, 0.05)}
						{light.type === "directional" && lightSlider("softness", ko("Shadow softness", "그림자 부드럽기"), 0, 1, 0.05)}
						{lightSlider("flicker", ko("Flicker", "깜빡임"), 0, 1, 0.05)}
						<label className="check details-toggle-row">
							<span>{capped ? ko(`Shadow (off: only ${PRACTICAL_SHADOW_CAP} lights cast)`, `그림자 (꺼짐: ${PRACTICAL_SHADOW_CAP}개까지만)`) : ko("Shadow", "그림자")}</span>
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
