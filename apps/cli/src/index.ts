#!/usr/bin/env node
import chalk from "chalk";
import { createCli } from "./cli.js";

try {
	await createCli().parseAsync();
} catch (err) {
	console.error(chalk.red(err instanceof Error ? err.message : String(err)));
	process.exitCode = 1;
}
