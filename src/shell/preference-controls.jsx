import { useState } from "react";
import { ko, LOCALE, setLocale } from "../locale.js";
import { readTheme, saveTheme } from "../theme.js";
import { WORLD_SCALE, setWorldScale } from "../world-scale.js";

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "") ? "⌘" : "Ctrl ";

const HOTKEYS = [
	["Move", "W", "이동"],
	["Rotate", "E", "회전"],
	["Scale", "R", "크기 조절"],
	["Frame selection", "F", "선택 프레임"],
	["Duplicate", `${MOD}D`, "복제"],
	["Drop to floor", "End", "바닥에 놓기"],
];

export function PreferenceRow({ title, description, children, testid, full = false }) {
	return (
		<div className={"v2-preferences__row" + (full ? " v2-preferences__row--full" : "")} data-testid={testid}>
			<div className="v2-preferences__row-copy">
				<span className="v2-preferences__row-title">{title}</span>
				{description && <span className="v2-preferences__row-description">{description}</span>}
			</div>
			<div className="v2-preferences__row-control">{children}</div>
		</div>
	);
}

// A page with one section leaves out its title: the page header already names it.
export function PreferenceSection({ title, children }) {
	return (
		<section className="v2-preferences__section">
			{title && <h2 className="v2-preferences__section-title">{title}</h2>}
			<div className="v2-preferences__section-rows">{children}</div>
		</section>
	);
}

export function ToggleControl({ pressed, onChange, label, testid }) {
	return (
		<button
			type="button"
			className="v2-preferences__toggle"
			role="switch"
			aria-checked={pressed}
			aria-pressed={pressed}
			aria-label={label}
			data-testid={testid}
			onClick={() => onChange(!pressed)}
		>
			<span className="v2-preferences__toggle-thumb" aria-hidden="true" />
		</button>
	);
}

export function ThemeControls() {
	const [theme, setTheme] = useState(readTheme);
	const options = [
		{ id: "dark", label: ko("Dark", "다크") },
		{ id: "light", label: ko("Light", "라이트", "浅色") },
	];
	return (
		<div className="v2-preferences__language-controls" role="group" aria-label={ko("Theme", "테마")}>
			{options.map((option) => (
				<button
					type="button"
					key={option.id}
					className={"v2-preferences__language" + (theme === option.id ? " is-selected" : "")}
					data-testid={`settings-theme-${option.id}`}
					aria-pressed={theme === option.id}
					onClick={() => setTheme(saveTheme(option.id))}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export function LanguageControls() {
	const options = [
		{ id: "en", label: "English", action: "Switch to English" },
		{ id: "ko", label: "한국어", action: "한국어로 전환" },
		{ id: "zh", label: "简体中文", action: "切换到中文" },
	];
	return (
		<div className="v2-preferences__language-controls">
			{options.map((language) => (
				<button
					type="button"
					key={language.id}
					className={"v2-preferences__language" + (LOCALE === language.id ? " is-selected" : "")}
					data-testid={`settings-locale-${language.id}`}
					aria-pressed={LOCALE === language.id}
					title={language.action}
					onClick={() => setLocale(language.id)}
				>
					{language.label}
				</button>
			))}
		</div>
	);
}

export function WorldScaleControls() {
	const options = [
		{ id: "room", label: ko("Room", "방", "房间") },
		{ id: "large", label: ko("Large", "대형", "大场景") },
	];
	return (
		<div className="v2-preferences__language-controls" role="group" aria-label={ko("World scale", "월드 크기", "世界尺度")}>
			{options.map((option) => (
				<button
					type="button"
					key={option.id}
					className={"v2-preferences__language" + (WORLD_SCALE === option.id ? " is-selected" : "")}
					data-testid={`settings-world-${option.id}`}
					aria-pressed={WORLD_SCALE === option.id}
					onClick={() => setWorldScale(option.id)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export function ReadonlyHotkeys() {
	return (
		<div className="v2-preferences__hotkeys" data-testid="preferences-hotkeys">
			{HOTKEYS.map(([english, key, korean]) => (
				<div className="v2-preferences__hotkey" key={english}>
					<span>{ko(english, korean)}</span>
					<kbd>{key}</kbd>
				</div>
			))}
		</div>
	);
}
