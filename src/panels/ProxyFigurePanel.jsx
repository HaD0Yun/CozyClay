import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { POSTURES, isProxyFigure } from "../scenes.js";
import { useBus } from "../app-context.js";

const POSTURE_LABELS = {
	stand: () => ko("Stand", "서기"),
	sit: () => ko("Sit", "앉기"),
	lie: () => ko("Lie", "눕기"),
};

// Side-on silhouettes on a 24 grid, the stroke family of the shell's icons.
const POSTURE_GLYPHS = {
	stand: "M12 3.5a2 2 0 1 1 0 4 2 2 0 1 1 0-4z M12 9.5v11",
	sit: "M10 4a2 2 0 1 1 0 4 2 2 0 1 1 0-4z M10 10v6h6v4.5",
	lie: "M4 13a2 2 0 1 1 0 4 2 2 0 1 1 0-4z M8 15h12.5",
};

/** Details for a capsule figure: it has no rig and no bones, so the one body
 * choice is its posture. Rig figures never see this panel. */
export default function ProxyFigurePanel({ isCharacterSelection, activeChar }) {
	const { run } = useBus();
	const selectedPosture = activeChar.posture;
	if (!isProxyFigure(activeChar)) return null;
	return (
		<Foldout hidden={!isCharacterSelection} title={ko("Capsule figure", "캡슐 인물")}>
			<div className="rig-picker" role="radiogroup" aria-label={ko("Posture", "자세")} data-testid="proxy-posture" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
				{POSTURES.map((posture) => (
					<button
						type="button"
						key={posture}
						role="radio"
						aria-checked={selectedPosture === posture}
						className={"rig-option" + (selectedPosture === posture ? " active" : "")}
						data-posture={posture}
						onClick={() => {
							if (selectedPosture === posture) return;
							run("character.update", { characterId: activeChar.id, patch: { posture } });
						}}
					>
						<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
							<path d={POSTURE_GLYPHS[posture]} />
						</svg>
						<span>{POSTURE_LABELS[posture]()}</span>
					</button>
				))}
			</div>
		</Foldout>
	);
}
