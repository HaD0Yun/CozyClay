import { ko } from "../locale.js";
import { contextMeter } from "./agent-context-meter.js";

// One compact line beside the activity text: the latest request's prompt against the model's window. No colour; the
// percentage turns bold once the request used more than 80% of the window.
export function AgentContextMeter({ context }) {
	const meter = contextMeter(context);
	if (!meter) return null;
	const title = ko("Context used by the latest model request", "최근 모델 요청이 쓴 컨텍스트");
	return <span className="agent-context-meter" data-agent-context={meter.percent ?? "unknown"} data-agent-context-hot={meter.hot ? "true" : "false"} title={title} aria-label={`${title}: ${meter.text}`}>
		CTX {meter.used}{meter.window && <> / {meter.window} ({meter.hot ? <strong>{meter.percent}%</strong> : `${meter.percent}%`})</>}
	</span>;
}
