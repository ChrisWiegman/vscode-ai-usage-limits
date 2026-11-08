import * as path from "path";
import * as sinon from "sinon";

/** Compiled extension sources (out/src). This file lives in out/test/suite. */
const SOURCE_DIR = path.resolve(__dirname, "../../src") + path.sep;

/** Returns the file of the function that called the function calling this one. */
function callerFile(): string | undefined {
	const original = Error.prepareStackTrace;

	try {
		Error.prepareStackTrace = (_err, callSites) => callSites;
		const holder: { stack?: NodeJS.CallSite[] } = {};

		Error.captureStackTrace(holder, callerFile);
		// [0] is the replacement installed by stubForSource, [1] is whoever called it.
		return holder.stack?.[1]?.getFileName() ?? undefined;
	} finally {
		Error.prepareStackTrace = original;
	}
}

/**
 * Stubs `obj[method]` for calls made by the extension's own code only.
 *
 * Tests run inside a live extension host shared with VS Code and its built-in
 * extensions. A plain `sinon.stub(fs, "readFileSync")` also intercepts their
 * calls — including Node's module loader when VS Code lazily loads a bundled
 * dependency mid-test, which can crash the whole host. Calls from anywhere
 * outside out/src go to the real implementation and are not recorded.
 *
 * The returned stub is configured and asserted like any sinon stub, and is
 * removed by `sinon.restore()`.
 */
export function stubForSource<T extends object, K extends keyof T>(obj: T, method: K): sinon.SinonStub {
	const real = obj[method] as unknown as (...args: unknown[])=> unknown;
	const fake = sinon.stub();

	function replacement(this: unknown, ...args: unknown[]): unknown {
		const file = callerFile();

		return file?.startsWith(SOURCE_DIR) ? fake.apply(this, args) : real.apply(this, args);
	}

	sinon.replace(obj, method, replacement as unknown as T[K]);
	return fake;
}
