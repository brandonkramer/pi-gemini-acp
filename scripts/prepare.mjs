import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let lefthook;
try {
	lefthook = require.resolve("lefthook");
} catch (error) {
	// Production installs omit the development dependency used for Git hooks.
	if (error.code !== "MODULE_NOT_FOUND") throw error;
}

if (lefthook) {
	const result = spawnSync(process.execPath, [lefthook, "install"], {
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}
