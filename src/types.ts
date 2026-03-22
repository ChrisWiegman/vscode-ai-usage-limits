/**
 * Usage data for a single time window (e.g. last 5 hours or last 7 days).
 */
export interface UsagePeriod {
  /** Value used during this window (USD or percent depending on `unit`). */
  used: number;
  /** Budget limit for this window, or null if no limit is set. */
  limit: number | null;
  /** Display unit for `used`/`limit`. */
  unit?: 'usd' | 'percent';
  /** When this usage window resets, if known. */
  resetsAt?: Date;
}

/**
 * Budget information returned by a provider.
 */
export interface BudgetInfo {
  fiveHour: UsagePeriod | null;
  oneWeek: UsagePeriod | null;
}

/**
 * The full status of a single AI service provider.
 */
export interface ProviderStatus {
  /** Whether the companion extension is installed. */
  available: boolean;
  /** Whether a valid auth session was found. */
  authenticated: boolean;
  /** Fetched budget data, or null while loading / on error. */
  budget: BudgetInfo | null;
  /** Human-readable error message, or null when healthy. */
  error: string | null;
}
