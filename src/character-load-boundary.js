// A character's model file can fail to load (#1197): drei's useFBX rejects with
// Error("Could not load <url>: <message>") and React rethrows it on render. Left
// alone it climbs past the Canvas to the root crash screen and takes the whole
// stage, every other character included, down with it. This boundary keeps the
// failure local: it warns once and shows `fallback` (the proxy figure) in the
// body's place. Key it by the model URL so a new URL gets a fresh attempt.
import { Component } from "react";

export class CharacterLoadBoundary extends Component {
	constructor(props) {
		super(props);
		this.state = { failed: false };
	}

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error) {
		console.warn(`[cozyclay] character model ${this.props.url} failed to load; showing the proxy figure`, error?.message ?? error);
	}

	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}
