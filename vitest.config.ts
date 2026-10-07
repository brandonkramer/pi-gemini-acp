import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "**/.pi/**"],
		maxWorkers: 3,
		env: {
			GEMINI_CLI: "",
		},
	},
});
