#!/usr/bin/env node
/** @file ACP stdio bridge for Antigravity CLI (agy). */
import { createAgyAcpAdapter } from "./adapter.ts";

const adapter = createAgyAcpAdapter({
	agyCommand: process.env.AGY_COMMAND ?? "agy",
	agyArgs: process.env.AGY_ARGS ? process.env.AGY_ARGS.split(" ") : [],
	sandbox: process.env.AGY_SANDBOX === "1",
});

adapter.start();
