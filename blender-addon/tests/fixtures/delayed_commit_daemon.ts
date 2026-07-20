import {
	createApplyCameraPlanHandler,
	createDirectorProjectStore,
	type CameraPlanRevisionStore,
} from "@oh-my-blender/director-runtime";
import { start } from "../../../apps/omb-daemon/src/daemon.ts";

const persistentStore = createDirectorProjectStore(process.cwd());
const failCommit = process.argv.includes("--fail-commit");
const store: CameraPlanRevisionStore = {
	readProject: () => persistentStore.readProject(),
	commitRevision: async (expectedRevisionId, project, journalEntry) => {
		await new Promise((resolve) => setTimeout(resolve, 500));
		if (failCommit) throw new Error("COMMIT_REJECTED: injected pre-commit failure");
		await persistentStore.commitRevision(expectedRevisionId, project, journalEntry);
	},
};
const project = await persistentStore.readProject();

const daemon = await start({
	projectId: project.project_id,
	port: 0,
	handlers: { apply_camera_plan: createApplyCameraPlanHandler({ store }) },
});
await daemon.stopped;
process.exit(0);
