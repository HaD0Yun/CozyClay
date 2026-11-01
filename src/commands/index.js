// The editor's Studio actions: ONE registry whose entries call the same
// handlers the UI controls call, so a timeline button and the agent's
// run_action share one code path. Each command module registers its own
// actions over `ports`, the one generic port object App refreshes on every
// render; `ports.state()` reads the synchronously published document, so an
// action sees its own edit at once.
import { createStudioActionRegistry, STUDIO_ACTIONS } from "../studio-actions.js";
import * as shot from "./shot.js";
import * as cast from "./cast.js";
import * as motion from "./motion.js";
import * as motion3 from "./motion3.js";
import * as motion3Fill from "./motion3-fill.js";
import * as objects from "./objects.js";
import * as view from "./view.js";
import * as scene from "./scene.js";
import * as project from "./project.js";
import * as exporting from "./export.js";
import * as ai from "./ai.js";
import * as stage from "./stage.js";
import * as kits from "./kits.js";
import * as physics from "./physics.js";

export const COMMAND_MODULES = Object.freeze({ shot, cast, motion, motion3, motion3Fill, physics, objects, kits, view, scene, project, export: exporting, ai, stage });

export function commandDeclarations(modules = COMMAND_MODULES) {
	return Object.values(modules).flatMap(module => module.declarations.map(declaration => ({
		...STUDIO_ACTIONS.find(entry => entry.id === declaration.id), ...declaration,
	})));
}

export function createStudioAppActions(ports, modules = COMMAND_MODULES) {
	const registry = createStudioActionRegistry({ readState: () => ports.state() });
	const declarations = new Map(commandDeclarations(modules).map(entry => [entry.id, entry]));
	const register = registry.register;
	registry.register = entry => register({ ...entry, ...declarations.get(entry.id) });
	const aliases = new Map();
	registry.registerToolAlias = (tool, action, args = value => value) => {
		if (aliases.has(tool)) throw new Error(`Tool alias already registered: ${tool}`);
		aliases.set(tool, { action, args });
	};
	registry.toolAlias = tool => aliases.get(tool);
	for (const module of Object.values(modules)) module.register(registry, ports);
	return registry;
}
