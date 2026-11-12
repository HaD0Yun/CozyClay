// A character's model file can fail to load (#1197): drei's useFBX rejects with
// Error("Could not load <url>: <message>") and React rethrows it on render. Left
// alone it climbs past the Canvas to the root crash screen and takes the whole
// stage, every other character included, down with it. This boundary keeps the
// failure local: it warns once and shows `fallback` (the proxy figure) in the
// body's place. Key it by the model URL so a new URL gets a fresh attempt.
// Only that failure ends here. Any other render error is a real crash: it is
// thrown on, so it still reaches the crash screen and its telemetry.
import { Component } from "react";

const isLoadFailure = (error) => typeof error?.message === "string" && error.message.startsWith("Could not load ");

export class CharacterLoadBoundary extends Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}

	static getDerivedStateFromError(error) {
		return { error };
	}

	componentDidCatch(error) {
		if (isLoadFailure(error)) console.warn(`[cozyclay] character model ${this.props.url} failed to load; showing the proxy figure`, error.message);
	}

	render() {
		const { error } = this.state;
		if (!error) return this.props.children;
		if (!isLoadFailure(error)) throw error;
		return this.props.fallback;
	}
}
