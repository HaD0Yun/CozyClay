import { ko } from "./locale.js";
import { EMPTY_KIND, OBJECT_MENU_ENTRIES } from "./scene-objects.js";

const GROUP_LABELS_KO = {
	Primitives: "기본 도형",
	Lights: "조명",
	Effects: "효과",
	Text: "텍스트",
};

const OBJECT_LABELS_KO = {
	Empty: "빈 오브젝트",
	Cube: "큐브",
	Sphere: "구",
	Capsule: "캡슐",
	Cylinder: "원기둥",
	Cone: "원뿔",
	Plane: "평면",
	"Point light": "점 조명",
	"Spot light": "스포트 조명",
	Light: "조명",
	Effect: "효과",
	Text: "텍스트",
};

function displayObjectGroupName(name) {
	return GROUP_LABELS_KO[name] ? ko(name, GROUP_LABELS_KO[name]) : name;
}

export function displayObjectLabel(label) {
	const numbered = label.match(/^(.+?) (\d+)$/);
	if (numbered && OBJECT_LABELS_KO[numbered[1]]) return `${ko(numbered[1], OBJECT_LABELS_KO[numbered[1]])} ${numbered[2]}`;
	return OBJECT_LABELS_KO[label] ? ko(label, OBJECT_LABELS_KO[label]) : label;
}

/** The catalogue grouped by section. Shared with the hierarchy's right-click
 * create menu so both entry points list the same objects
 * (docs/unity-reference.md §9.7). */
function buildObjectMenuGroups() {
	const groups = [];
	for (const entry of OBJECT_MENU_ENTRIES) {
		const group = groups.find((item) => item.name === entry.group);
		if (group) group.entries.push(entry);
		else groups.push({ name: entry.group, entries: [entry] });
	}
	return groups;
}

/** One rendered entry list; the toolbar popover and the right-click create
 * menu both use it so the two can never drift apart. */
export function CatalogueEntries({ onPick }) {
	return buildObjectMenuGroups().map((group) => (
		<div className="add-object-group" key={group.name}>
			<span className="add-object-heading">{displayObjectGroupName(group.name)}</span>
			{group.entries.map((entry) => (
				<button
					type="button"
					role="menuitem"
					key={entry.kind}
					className="add-object-item"
					onClick={() => onPick(entry.kind)}
				>
					<span className={`add-object-swatch ${entry.kind}`} style={{ background: entry.color }} aria-hidden="true" />
					<span>{displayObjectLabel(entry.label)}</span>
					{/* An empty has no size to quote: say what it is instead of "0 × 0 m". */}
					<small>{entry.light ? ko("practical light", "실제 조명") : entry.kind === EMPTY_KIND ? ko("empty, no geometry", "빈 오브젝트, 형상 없음", "空对象，无几何体") : entry.kind === "effect" ? ko("smoke, fire, rain…", "연기, 불, 비…") : entry.kind === "text" ? ko("words, signs, logos", "글자, 간판, 로고") : `${entry.footprint.width} × ${entry.footprint.depth} m`}</small>
				</button>
			))}
		</div>
	));
}
