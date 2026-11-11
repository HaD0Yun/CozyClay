// Simplified Chinese dictionary, keyed by the English default passed to ko().
// Split by area so no file crosses the 250-line ratchet; assembled here.
import { ZH_APP } from "./locale-zh/app.js";
import { ZH_DOMAINS } from "./locale-zh/domains.js";
import { ZH_LABELS } from "./locale-zh/labels.js";
import { ZH_PANELS } from "./locale-zh/panels.js";
import { ZH_PREVIS } from "./locale-zh/previs.js";
import { ZH_SHELL } from "./locale-zh/shell.js"; import { ZH_CHIPS } from "./locale-zh/chips.js";
import { ZH_TIMELINE } from "./locale-zh/timeline.js"; import { ZH_TUTORIAL } from "./locale-zh/tutorial.js";
import { ZH_WORKFLOW } from "./locale-zh/workflow.js";
import { ZH_WORKSPACE } from "./locale-zh/workspace.js";

export const ZH = Object.freeze({
	...ZH_APP,
	...ZH_DOMAINS,
	...ZH_LABELS,
	...ZH_PANELS,
	...ZH_PREVIS,
	...ZH_SHELL, ...ZH_CHIPS,
	...ZH_TIMELINE, ...ZH_TUTORIAL,
	...ZH_WORKFLOW,
	...ZH_WORKSPACE,
});
