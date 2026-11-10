import { FiDownload, FiPower, FiRotateCw } from "react-icons/fi";
import { ko } from "../locale.js";

// A page served over https is the hosted Studio (cozyclay.org/app/): a static build with no agent server to start,
// so Retry could only fail. `npx cozyclay` and a checkout serve http on loopback or the LAN; `?try` asks for the
// hosted first run there.
const hostedPage = () => globalThis.location?.protocol === "https:" || new URLSearchParams(globalThis.location?.search ?? "").has("try");
// the landing page opens its install steps (the Node.js download, then the one command) on this hash
const INSTALL_URL = "https://cozyclay.org/#install";

// No agent server answered. Self-served: say how to start it. Hosted: the agent needs CozyClay on the visitor's
// computer, so the card is the way to get it (one Install button), and one line on what moves without it.
export function OfflineCard({ probing, onRetry }) {
	if (hostedPage()) return <div className="agent-state-card agent-offline-card" data-agent-card="offline" data-agent-offline="hosted" role="status" aria-live="polite">
		<h3>{ko("The agent runs on your computer", "에이전트는 내 컴퓨터에서 실행돼요", "智能体在你的电脑上运行")}</h3>
		<p>{ko("Install CozyClay and it builds scenes and motion from your words.", "CozyClay를 설치하면 말로 장면과 동작을 만들어 줍니다.", "安装 CozyClay 后，它会按你的描述搭建场景和动作。")}</p>
		<a className="agent-primary-button agent-offline-install" href={INSTALL_URL} target="_blank" rel="noreferrer"><FiDownload size={13} aria-hidden="true" /> {ko("Install CozyClay", "CozyClay 설치", "安装 CozyClay")}</a>
		<p className="agent-offline-note">{ko("Without it: select the character, open the Motion tab and pick a sample motion.", "설치 없이: 캐릭터를 고르고 Motion 탭에서 샘플 동작을 누르세요.", "不安装也可以：选中角色，打开 Motion 标签页，点一个示例动作。")}</p>
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
