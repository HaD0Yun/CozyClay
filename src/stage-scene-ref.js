// The three.js scene the stage canvas draws (the viewport, the shot preview and every export render it), for a check
// that reads what was drawn rather than what was asked: verify_result lighting (stage-light-facts.js). Set by
// StageSceneProbe inside the stage canvas; null while no stage canvas is mounted.
let current = null;

export function setStageScene(scene) {
	current = scene;
}

export function stageScene() {
	return current;
}
