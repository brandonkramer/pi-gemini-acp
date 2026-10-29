import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "../..");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

describe("chat preamble scope", () => {
	it("is built only by the chat stream", () => {
		const builders = sourceFiles(SRC)
			.filter((file) =>
				/\bcreatePreambleBuilder\(|\bbuildPiPreamble\(/u.test(readFileSync(file, "utf8")),
			)
			.map((file) => path.relative(SRC, file).split(path.sep).join("/"))
			.toSorted();
		expect(builders).toEqual(["models/preamble.ts", "models/stream.ts"]);
	});
});
