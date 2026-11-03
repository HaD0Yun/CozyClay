import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "reactflow/dist/style.css";
import "./workflow.css";
import "./cozy-scene-node.css";
import WorkflowBuilder from "./WorkflowBuilder.jsx";
import { initAnalytics } from "../analytics.js";
import { installDomMutationGuard } from "../dom-mutation-guard.js";

installDomMutationGuard();
void initAnalytics();

createRoot(document.getElementById("workflow-root")).render(
	<StrictMode>
		<WorkflowBuilder />
	</StrictMode>,
);
