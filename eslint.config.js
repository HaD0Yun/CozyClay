// Flat ESLint config. Errors are ratcheted per rule by tools/check-eslint.mjs.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default [
	{
		ignores: [
			"dist/**",
			"node_modules/**",
			"**/node_modules/**",
			"public/**",
			"mcp/runtime/**",
		],
	},
	{
		files: ["**/*.{js,jsx,mjs}"],
		plugins: { "react-hooks": reactHooks },
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			parserOptions: { ecmaFeatures: { jsx: true } },
			globals: { ...globals.browser, ...globals.node },
		},
		rules: {
			...js.configs.recommended.rules,
			...reactHooks.configs.flat.recommended.rules,
			"no-unused-vars": [
				"error",
				{ args: "after-used", ignoreRestSiblings: true, caughtErrors: "none" },
			],
			// Empty blocks that hold a comment are always allowed by no-empty.
			"no-empty": ["error", { allowEmptyCatch: true }],
		},
	},
];
