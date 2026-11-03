import * as assert from "assert";
import * as sinon from "sinon";
import { EventEmitter, PassThrough } from "stream";
import childProcess = require("child_process");
import {
	REFRESH_COOLDOWN_MS,
	refreshClaudeToken,
	resetRefreshCooldown,
} from "../../src/claudeTokenRefresher";

/** A stand-in for the `claude` process: answers the initialize request with `reply`. */
function fakeCli(reply: ((written: string)=> string | null) | null) {
	const child = new EventEmitter() as EventEmitter & {
		stdin: PassThrough;
		stdout: PassThrough;
		kill: sinon.SinonSpy;
	};
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.kill = sinon.spy();
	const written: string[] = [];
	child.stdin.on("data", (chunk: Buffer) => {
		written.push(chunk.toString());
		const line = reply?.(chunk.toString());
		if (line !== null && line !== undefined) setImmediate(() => child.stdout.write(line));
	});
	return { child, written };
}

suite("claudeTokenRefresher", () => {
	let spawnStub: sinon.SinonStub;
	let clock: sinon.SinonFakeTimers | undefined;
	const savedEnv = { ...process.env };

	setup(() => {
		resetRefreshCooldown();
		spawnStub = sinon.stub(childProcess, "spawn");
	});

	teardown(() => {
		clock?.restore();
		clock = undefined;
		sinon.restore();
		process.env = { ...savedEnv };
	});

	test("asks the CLI to initialize, without the alternate auth env, and resolves on success", async () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-long-lived";
		process.env.ANTHROPIC_API_KEY = "sk-ant-api03-x";
		const { child, written } = fakeCli(() =>
			JSON.stringify({ type: "control_response", response: { subtype: "success", response: {} } }) + "\n",
		);
		spawnStub.returns(child);

		assert.strictEqual(await refreshClaudeToken("/fake/claude"), true);

		const [cmd, args, options] = spawnStub.firstCall.args as [string, string[], childProcess.SpawnOptions];
		assert.strictEqual(cmd, "/fake/claude");
		assert.deepStrictEqual(args, ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"]);
		assert.strictEqual(options.env!.CLAUDE_CODE_OAUTH_TOKEN, undefined, "must use the stored credentials");
		assert.strictEqual(options.env!.ANTHROPIC_API_KEY, undefined);
		const request = JSON.parse(written.join("").trim());
		assert.deepStrictEqual(request.request, { subtype: "initialize" });
		assert.strictEqual(request.type, "control_request");
		assert.ok(child.kill.called, "the CLI is stopped right after answering");
	});

	test("resolves false on an error answer, an early exit or a spawn error", async () => {
		const failing = fakeCli(() =>
			JSON.stringify({ type: "control_response", response: { subtype: "error", error: "x" } }) + "\n",
		);
		spawnStub.returns(failing.child);
		assert.strictEqual(await refreshClaudeToken("/fake/claude"), false);

		resetRefreshCooldown();
		const exiting = fakeCli(null);
		spawnStub.returns(exiting.child);
		setImmediate(() => exiting.child.emit("exit", 1));
		assert.strictEqual(await refreshClaudeToken("/fake/claude"), false);

		resetRefreshCooldown();
		const broken = fakeCli(null);
		spawnStub.returns(broken.child);
		setImmediate(() => broken.child.emit("error", new Error("ENOENT")));
		assert.strictEqual(await refreshClaudeToken("/fake/claude"), false);
	});

	test("ignores noise before the answer, split across chunks", async () => {
		const answer = JSON.stringify({ type: "control_response", response: { subtype: "success" } });
		const { child } = fakeCli(() => `not json\n{"type":"system"}\n${answer.slice(0, 10)}`);
		spawnStub.returns(child);
		const pending = refreshClaudeToken("/fake/claude");
		setTimeout(() => child.stdout.write(`${answer.slice(10)}\n`), 5);
		assert.strictEqual(await pending, true);
	});

	test("does nothing without a CLI, and not twice within the cooldown", async () => {
		assert.strictEqual(await refreshClaudeToken(""), false);
		assert.strictEqual(spawnStub.callCount, 0);

		const { child } = fakeCli(() =>
			JSON.stringify({ type: "control_response", response: { subtype: "success" } }) + "\n",
		);
		spawnStub.returns(child);
		clock = sinon.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
		assert.strictEqual(await refreshClaudeToken("/fake/claude"), true);
		assert.strictEqual(await refreshClaudeToken("/fake/claude"), false, "within the cooldown");
		assert.strictEqual(spawnStub.callCount, 1);
		clock.tick(REFRESH_COOLDOWN_MS + 1);
		assert.strictEqual(await refreshClaudeToken("/fake/claude"), true);
		assert.strictEqual(spawnStub.callCount, 2);
	});
});
