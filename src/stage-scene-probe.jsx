import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { setStageScene, stageScene } from "./stage-scene-ref.js";

/** Publishes the stage canvas's scene to stage-scene-ref.js while it is mounted. Draws nothing. */
export default function StageSceneProbe() {
	const scene = useThree((state) => state.scene);
	useEffect(() => {
		setStageScene(scene);
		return () => {
			if (stageScene() === scene) setStageScene(null);
		};
	}, [scene]);
	return null;
}
