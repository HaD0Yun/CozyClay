import { Component } from "react";
import { ko } from "./locale.js";
import { reportRenderCrash } from "./crash-telemetry.js";

const DYNAMIC_IMPORT_ERROR = "Failed to fetch dynamically imported module:";
const DYNAMIC_IMPORT_RETRY_KEY = "cozyclay.dynamic-import-retry.v1";
const isDynamicImportFailure = (error) => typeof error?.message === "string" && error.message.startsWith(DYNAMIC_IMPORT_ERROR);

/**
 * Last line of defense for the whole tree. A render-time throw anywhere in
 * App unmounts everything React manages, and over an autosaving document
 * that reads as a silent white page, mid-edit, with no message and no way
 * back. Catch it, say what broke, and offer the one recovery that always
 * works: reload, which resumes from the last autosaved state.
 *
 * Deliberately dependency-free beyond ko(): the fallback must render when
 * app state is exactly what just crashed.
 */
export default class ErrorBoundary extends Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}

	static getDerivedStateFromError(error) {
		return { error };
	}

	componentDidCatch(error, info) {
		if (isDynamicImportFailure(error)) {
			try {
				if (!sessionStorage.getItem(DYNAMIC_IMPORT_RETRY_KEY)) {
					sessionStorage.setItem(DYNAMIC_IMPORT_RETRY_KEY, "1");
					window.location.reload();
					return;
				}
			} catch {
				// Keep the crash screen when session storage is unavailable.
			}
		}
		console.error("[cozyclay] render crash", error, info?.componentStack ?? "");
		reportRenderCrash(error);
	}

	render() {
		if (!this.state.error) return this.props.children;
		return (
			<div className="crash-screen" role="alert">
				<h1>{ko("The studio hit a render error", "스튜디오에 렌더링 오류가 발생했어요")}</h1>
				<p>{ko("Scenes autosave as you work, so reloading resumes from the last saved state.", "작업 중 장면은 자동 저장되므로, 새로고침하면 마지막 저장 상태에서 이어집니다.")}</p>
				<pre className="crash-detail">{String(this.state.error.message || this.state.error)}</pre>
				<button type="button" onClick={() => window.location.reload()}>
					{ko("Reload the studio", "스튜디오 새로고침")}
				</button>
			</div>
		);
	}
}
