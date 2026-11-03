/**
 * Renews the Claude Code OAuth access token stored in the Keychain /
 * credentials file when it has expired.
 *
 * Claude Code refreshes that token itself whenever it starts a session. When
 * every Claude Code process authenticates another way instead — for example
 * with a long-lived `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` — nothing
 * renews the stored token any more: it expires after a few hours and the usage
 * endpoint rejects it, so the status bar shows no data.
 *
 * The renewal is Claude Code's own: start the `claude` CLI the way the Claude
 * Agent SDK does (stream-json), send the `initialize` control request — which
 * makes it load (and refresh) its stored credentials — and stop it as soon as
 * it answers. No model request is made, and this extension never reads or
 * writes the refresh token itself.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** How long to wait for the CLI to answer before giving up. */
export const REFRESH_TIMEOUT_MS = 30_000;

/** Minimum time between two renewal attempts, so a failing one is not repeated every refresh. */
export const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Variables that make Claude Code authenticate with something other than its
 * stored credentials: with any of them set, it would not touch the stored token.
 */
const ALTERNATE_AUTH_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

let lastAttemptAt: number | null = null;

/** Forget the cooldown (tests). */
export function resetRefreshCooldown(): void {
	lastAttemptAt = null;
}

/**
 * Where the `claude` CLI is, or undefined. VS Code started from the Dock does
 * not get the login shell's PATH, so the usual install locations are tried too.
 */
export function findClaudeCli(): string | undefined {
	const name = process.platform === "win32" ? "claude.exe" : "claude";
	const home = os.homedir();
	const dirs = [
		...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
		path.join(home, ".local", "bin"),
		path.join(home, ".claude", "local"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	];

	for (const dir of dirs) {
		const candidate = path.join(dir, name);

		try {
			fs.accessSync(candidate, fs.constants.X_OK);

			return candidate;
		} catch {
			// Not here – try the next one.
		}
	}

	return undefined;
}

/**
 * Asks Claude Code to renew its stored token. Resolves true when the CLI
 * answered the `initialize` request successfully (the caller re-reads the
 * credentials to see whether the token is fresh now), false otherwise —
 * including when an attempt was made less than {@link REFRESH_COOLDOWN_MS} ago.
 */
export async function refreshClaudeToken(cliPath = findClaudeCli()): Promise<boolean> {
	if (!cliPath) return false;

	const now = Date.now();

	if (lastAttemptAt !== null && now - lastAttemptAt < REFRESH_COOLDOWN_MS) return false;

	lastAttemptAt = now;

	const env = { ...process.env };

	for (const name of ALTERNATE_AUTH_ENV) delete env[name];

	return new Promise<boolean>((resolve) => {
		let settled = false;
		let buffer = "";

		const child = spawn(
			cliPath,
			["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"],
			{ env, cwd: os.tmpdir(), stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
		);

		const finish = (ok: boolean) => {
			if (settled) return;

			settled = true;
			clearTimeout(timer);
			child.kill();
			resolve(ok);
		};

		const timer = setTimeout(() => finish(false), REFRESH_TIMEOUT_MS);

		child.on("error", () => finish(false));
		child.on("exit", () => finish(false));
		child.stdout?.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();

			const lines = buffer.split("\n");

			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const message = parseLine(line);

				if (message?.type === "control_response") {
					finish(message.response?.subtype === "success");

					return;
				}
			}
		});

		child.stdin?.on("error", () => finish(false));
		child.stdin?.write(
			JSON.stringify({
				type: "control_request",
				request_id: "ai-usage-limits-refresh",
				request: { subtype: "initialize" },
			}) + "\n",
		);
	});
}

function parseLine(line: string): { type?: string; response?: { subtype?: string } } | null {
	try {
		return JSON.parse(line) as { type?: string; response?: { subtype?: string } };
	} catch {
		return null;
	}
}
