/**
 * Cross-window shared cache for AI provider budget data.
 *
 * VS Code opens a separate extension host per window, so each window would
 * otherwise make independent API calls on every poll cycle.  By writing
 * results to a shared file (~/.claude/.ai-limits-cache.json) all windows on
 * the same machine share a single fetch per TTL window.
 *
 * Cache entries are keyed by a SHA-256 hash of the access token so that
 * multiple accounts on the same machine are handled correctly without storing
 * the token itself on disk.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BudgetInfo, UsagePeriod } from "./types";

/** How long a cached result is considered fresh. Matches the 5-minute poll
 *  interval so the cache never expires between polls, closing the window
 *  where a debounce-triggered refresh could slip in before the periodic one. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

export const CACHE_PATH = path.join(os.homedir(), ".claude", ".ai-limits-cache.json");

// ---------------------------------------------------------------------------
// Serialization types (dates become ISO strings on disk)
// ---------------------------------------------------------------------------

interface SerializedPeriod {
	used: number;
	limit: number | null;
	unit?: "usd" | "percent";
	resetsAt?: string;
}

interface SerializedBudget {
	fiveHour: SerializedPeriod | null;
	oneWeek: SerializedPeriod | null;
}

interface CacheEntry {
	fetchedAt: string;
	budget: SerializedBudget;
	/** ISO timestamp set when the API returned 429; skip fetches until this time. */
	backoffUntil?: string;
}

type CacheFile = Record<string, CacheEntry>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns a short, stable cache key derived from the token.  Exported for
 *  use in tests so they can construct valid cache fixtures. */
export function tokenKey(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Returns a fresh cached BudgetInfo for this token, or null on miss/stale.
 *  Returns an empty BudgetInfo (both periods null) when the last successful
 *  fetch returned no data — callers must not retry the API for a cache hit. */
export function readCache(key: string): BudgetInfo | null {
	try {
		const raw = fs.readFileSync(CACHE_PATH, "utf8");
		const file = JSON.parse(raw) as CacheFile;
		const entry = file[key];

		if (!entry?.fetchedAt) {
			return null;
		}

		const age = Date.now() - new Date(entry.fetchedAt).getTime();

		if (age > CACHE_TTL_MS) {
			return null;
		}

		return deserializeBudget(entry.budget ?? { fiveHour: null, oneWeek: null });
	} catch {
		return null;
	}
}

/** Removes the shared cache file so the next fetch is forced to hit the API.
 *  Failures are silently swallowed — the cache is best-effort. */
export function clearCache(): void {
	try {
		fs.unlinkSync(CACHE_PATH);
	} catch {
		// Deletion failure is non-fatal.
	}
}

/** Persists budget data to the shared cache file.  Failures are silently
 *  swallowed — the extension continues to work without cross-window dedup. */
export function writeCache(key: string, budget: BudgetInfo): void {
	try {
		let file: CacheFile = {};

		try {
			const raw = fs.readFileSync(CACHE_PATH, "utf8");

			file = JSON.parse(raw) as CacheFile;
		} catch {
			// File absent or corrupt — start fresh.
		}

		fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });

		file[key] = { fetchedAt: new Date().toISOString(), budget: serializeBudget(budget) };

		fs.writeFileSync(CACHE_PATH, JSON.stringify(file), "utf8");
	} catch {
		// Cache write failure is non-fatal.
	}
}

/** Returns the time until which API calls should be skipped for this token key,
 *  or null if no active backoff entry exists. */
export function getRateLimitBackoff(key: string): Date | null {
	try {
		const raw = fs.readFileSync(CACHE_PATH, "utf8");
		const file = JSON.parse(raw) as CacheFile;
		const entry = file[key];

		if (!entry?.backoffUntil) return null;

		const until = new Date(entry.backoffUntil);

		if (Number.isNaN(until.getTime()) || until <= new Date()) return null;

		return until;
	} catch {
		return null;
	}
}

/** Writes a rate-limit backoff marker so all windows skip the API until `until`.
 *  Any previously cached budget data is preserved so callers can still display it. */
export function writeRateLimitBackoff(key: string, until: Date): void {
	try {
		let file: CacheFile = {};

		try {
			const raw = fs.readFileSync(CACHE_PATH, "utf8");

			file = JSON.parse(raw) as CacheFile;
		} catch {
			// File absent or corrupt — start fresh.
		}

		fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });

		const existing = file[key];

		file[key] = {
			fetchedAt: existing?.fetchedAt ?? new Date().toISOString(),
			budget: existing?.budget ?? { fiveHour: null, oneWeek: null },
			backoffUntil: until.toISOString(),
		};

		fs.writeFileSync(CACHE_PATH, JSON.stringify(file), "utf8");
	} catch {
		// Cache write failure is non-fatal.
	}
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializePeriod(p: UsagePeriod): SerializedPeriod {
	return { used: p.used, limit: p.limit, unit: p.unit, resetsAt: p.resetsAt?.toISOString() };
}

function deserializePeriod(p: SerializedPeriod): UsagePeriod {
	const period: UsagePeriod = { used: p.used, limit: p.limit, unit: p.unit };

	if (p.resetsAt) {
		const d = new Date(p.resetsAt);

		if (!Number.isNaN(d.getTime())) {
			period.resetsAt = d;
		}
	}

	return period;
}

function serializeBudget(b: BudgetInfo): SerializedBudget {
	return {
		fiveHour: b.fiveHour ? serializePeriod(b.fiveHour) : null,
		oneWeek: b.oneWeek ? serializePeriod(b.oneWeek) : null,
	};
}

function deserializeBudget(b: SerializedBudget): BudgetInfo {
	return {
		fiveHour: b.fiveHour ? deserializePeriod(b.fiveHour) : null,
		oneWeek: b.oneWeek ? deserializePeriod(b.oneWeek) : null,
	};
}
