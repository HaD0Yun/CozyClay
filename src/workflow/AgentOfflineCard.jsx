import { FiPower, FiRotateCw } from "react-icons/fi";
import { ko } from "../locale.js";

// A page served over https is the hosted Studio (cozyclay.org/app/): a static build with no agent server to start,
// so Retry could only fail. `npx cozyclay` and a checkout serve http on loopback or the LAN.
const hostedPage = () => globalThis.location?.protocol === "https:";
const INSTALL_URL = "https://cozyclay.org/#start";

// No agent server answered. Self-served: say how to start it. Hosted: say what works on this page (staging, posing,
// the camera, and the sample takes in Motion mode, which need no agent) and where the agent does run.
export function OfflineCard({ probing, onRetry }) {
	if (hostedPage()) return <div className="agent-state-card agent-offline-card" data-agent-card="offline" data-agent-offline="hosted" role="status" aria-live="polite">
		<FiPower className="agent-offline-icon" size={18} aria-hidden="true" />
		<h3>{ko("The agent runs on your computer", "에이전트는 내 컴퓨터에서 실행돼요", "智能体在你的电脑上运行")}</h3>
		<p>{ko("On this page you can stage the scene, pose characters and set the camera. To see a character move, select it, open the Motion tab and pick a sample motion.",
			"이 페이지에서는 장면 배치, 포즈, 카메라까지 할 수 있어요. 캐릭터가 움직이는 걸 보려면 캐릭터를 고르고 Motion 탭에서 샘플 동작을 누르세요.",
			"在这个页面可以搭建场景、摆姿势和设置摄影机。想看角色动起来，选中角色，打开 Motion 标签页，点一个示例动作。")}</p>
		<p>{ko(<>To have the agent build scenes and motion from your words, run <code>npx cozyclay</code> on your computer.</>,
			<>말로 장면과 동작을 만들게 하려면 내 컴퓨터에서 <code>npx cozyclay</code>를 실행하세요.</>,
			<>想让智能体按你的描述搭建场景和动作，请在电脑上运行 <code>npx cozyclay</code>。</>)}</p>
		<a className="agent-ghost-button agent-offline-retry" href={INSTALL_URL} target="_blank" rel="noreferrer">{ko("How to install", "설치 방법", "安装方法")}</a>
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
