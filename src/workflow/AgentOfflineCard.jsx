import { FiDownload, FiPower, FiRotateCw } from "react-icons/fi";
import { ko } from "../locale.js";
import AgentHostedDemos from "./AgentHostedDemos.jsx";

// A page served over https is the hosted Studio (cozyclay.org/app/): a static build with no agent server to start,
// so Retry could only fail. `npx cozyclay` and a checkout serve http on loopback or the LAN; `?try` asks for the
// hosted first run there.
const hostedPage = () => globalThis.location?.protocol === "https:" || new URLSearchParams(globalThis.location?.search ?? "").has("try");
// the landing page opens its install steps (the Node.js download, then the one command) on this hash; from=studio
// makes that command say the install began here (src/install.js)
const INSTALL_URL = "https://cozyclay.org/?from=studio#install";

// No agent server answered. Self-served: say how to start it. Hosted: show what the agent does (a few requests
// as buttons, AgentHostedDemos.jsx), then the way to use it for real: the agent needs CozyClay on the visitor's
// computer, so the card ends in one Install button.
export function OfflineCard({ probing, onRetry }) {
	if (hostedPage()) return <div className="agent-state-card agent-offline-card" data-agent-card="offline" data-agent-offline="hosted" role="status" aria-live="polite">
		<h3>{ko("See what the agent does", "에이전트가 하는 일 보기", "看看智能体能做什么")}</h3>
		<p>{ko("Press a request. These are ready-made results.", "요청을 눌러 보세요. 미리 만들어 둔 결과입니다.", "点一个请求试试。这些是预先做好的结果。")}</p>
		<AgentHostedDemos />
		<p className="agent-offline-note">{ko("To direct it in your own words, install CozyClay. The agent runs on your computer.", "내 말로 직접 시키려면 CozyClay를 설치하세요. 에이전트는 내 컴퓨터에서 실행됩니다.", "想用自己的话指挥它，请安装 CozyClay。智能体在你的电脑上运行。")}</p>
		<a className="agent-primary-button agent-offline-install" href={INSTALL_URL} target="_blank" rel="noreferrer"><FiDownload size={13} aria-hidden="true" /> {ko("Install CozyClay", "CozyClay 설치", "安装 CozyClay")}</a>
	</div>;
	return <div className="agent-state-card agent-offline-card" data-agent-card="offline" role="status" aria-live="polite">
		<FiPower className="agent-offline-icon" size={18} aria-hidden="true" />
		<h3>{ko("Agent server is not running", "에이전트 서버가 실행 중이 아니에요")}</h3>
		<p>{ko(<>Start CozyClay with <code>npx cozyclay</code> (or <code>npm run dev</code> in a checkout) to sign in.</>,
			<>로그인하려면 <code>npx cozyclay</code>(체크아웃에서는 <code>npm run dev</code>)로 CozyClay를 시작하세요.</>, <>使用 <code>npx cozyclay</code> 启动 CozyClay（在代码检出中使用 <code>npm run dev</code>）即可登录。</>)}</p>
		<button type="button" className="agent-ghost-button agent-offline-retry" onClick={onRetry} disabled={probing} aria-busy={probing}>
			<FiRotateCw size={11} aria-hidden="true" /> {probing ? ko("Checking…", "확인 중…") : ko("Retry", "다시 확인", "重新检查")}
		</button>
	</div>;
}
