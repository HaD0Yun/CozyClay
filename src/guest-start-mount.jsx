// The guest start's side of the Studio (guest-start.js has the rule): it asks for a language, then once creates the
// project, puts one character on the stage, gives it a short walk (a sample motion, so the tutorial's Shot, Rail and
// Play steps have somebody moving), and shows the camera tutorial until it is closed.
import { useContext, useEffect, useRef, useState } from "react";
import { AppContext, useBus } from "./app-context.js";
import StudioCameraTutorial from "./camera-tutorial.jsx";
import TutorialLanguage from "./camera-tutorial-language.jsx";
import { guestStart } from "./guest-start.js";
import { ko, localeChosen } from "./locale.js";
import { sampleMotionSpec } from "./motion/sample-motions.js";
import { CHARACTER_MODEL_IDS } from "./scenes.js";
import { useStudioShell } from "./shell/studio-shell-context.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function GuestStart() {
	const { run } = useBus(), shell = useStudioShell(), app = useContext(AppContext), started = useRef(false);
	const [tutorial, setTutorial] = useState(() => guestStart());
	// The language comes first: choosing another one reloads the page, and the guest project must not exist yet
	// then, or the reload would resume it with no tutorial. A visitor who chose before goes straight in.
	const [language, setLanguage] = useState(localeChosen);
	useEffect(() => {
		if (!language || started.current || !guestStart()) return;
		started.current = true;
		void (async () => {
			const receipt = await run("project.new", { name: ko("Untitled Project", "제목 없는 프로젝트", "未命名项目") });
			if (!receipt?.ok) return;
			shell?.spawnCharacter?.(CHARACTER_MODEL_IDS[0], 0, 0);
			// The cast row lands with the add's commit, and the compile needs the rig loaded, which on a first visit is
			// a download. Both are waited for: a walk that misses its moment leaves the camera steps nobody to follow.
			let character = null;
			for (let tries = 0; tries < 120 && !character; tries += 1) { character = app?.storeDomain?.("cast")?.read?.().at(-1) ?? null; if (!character) await pause(250); }
			if (!character) return void console.warn("[cozyclay] guest start: no character to give the walk to");
			for (let tries = 0; tries < 20; tries += 1) {
				const walk = await run("motion.compile", { characterId: character.id, spec: sampleMotionSpec("walk", character), install: true }).catch((error) => ({ ok: false, message: String(error?.message ?? error) }));
				if (walk?.ok) return;
				if (tries === 19) console.warn("[cozyclay] guest start: the sample walk did not install:", walk?.message ?? walk?.code ?? walk);
				await pause(1500);
			}
		})();
	}, [language]); // eslint-disable-line react-hooks/exhaustive-deps -- once, when the language is settled
	if (!tutorial) return null;
	return language ? <StudioCameraTutorial onClose={() => setTutorial(false)} /> : <TutorialLanguage onChosen={() => setLanguage(true)} />;
}
