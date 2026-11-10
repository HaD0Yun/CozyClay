// Guest start: a first visit to the hosted Studio opens on a ready stage with a character standing on it, instead of
// the project chooser. A visitor who pressed "Try it" on the landing page came to try the Studio, and a dialog asking
// for a project name and a storage folder before anything is on screen is a decision they cannot make yet. The project
// is a normal one ("Untitled Project" in the browser store): it saves, renames and exports like any other, and
// File > New or Open still reach the chooser.
//
// It applies when there is no project session yet and the page is hosted (https) or asks for it with `?try`
// (`npx cozyclay` and a checkout serve http, and keep the chooser: there the author usually opens a file).
import { useEffect, useRef } from "react";
import { useBus } from "./app-context.js";
import { ko } from "./locale.js";
import { loadProjectSession } from "./project.js";
import { CHARACTER_MODEL_IDS } from "./scenes.js";
import { useStudioShell } from "./shell/studio-shell-context.js";

/** True when this load should skip the project chooser and start a guest project. */
export function guestStart(location = globalThis.location, storage = globalThis.localStorage) {
	const params = new URLSearchParams(location?.search ?? "");
	if (params.has("embed") || params.has("scene") || loadProjectSession(storage)?.name) return false;
	return location?.protocol === "https:" || params.has("try");
}

/** Renders nothing; on a guest start it creates the project and puts one character on the stage, once. */
export default function GuestStart() {
	const { run } = useBus(), shell = useStudioShell(), started = useRef(false);
	useEffect(() => {
		if (started.current || !guestStart()) return;
		started.current = true;
		void run("project.new", { name: ko("Untitled Project", "제목 없는 프로젝트", "未命名项目") }).then((receipt) => {
			if (receipt?.ok) shell?.spawnCharacter?.(CHARACTER_MODEL_IDS[0], 0, 0);
		});
	}, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, on the first mount
	return null;
}
