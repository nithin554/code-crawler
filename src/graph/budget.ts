/**
 * Token budgeting and cursor pagination for tool responses.
 *
 * Token counts are *estimates*: JSON payloads average roughly four characters
 * per token for source-code-adjacent text. Estimating avoids a tokenizer
 * dependency and keeps responses deterministic across models. The budget only
 * decides where to cut a list; it is never a hard failure condition.
 */

export interface BudgetOptions {
  /** Soft cap on the estimated tokens the returned items may cost. */
  maxTokens?: number;
  /** Zero-based offset into the item list. */
  cursor?: number;
}

export interface BudgetPage<T> {
  items: T[];
  /** Number of items available in the window handed to applyBudget. */
  totalCount: number;
  returnedCount: number;
  cursor: number;
  /** Offset to pass as `cursor` to fetch the next page. */
  nextCursor?: number;
  truncated: boolean;
  estimatedTokens: number;
}

/** Metadata describing a page, without the items themselves. */
export interface PageMeta {
  totalCount: number;
  returnedCount: number;
  cursor: number;
  nextCursor?: number;
  truncated: boolean;
  estimatedTokens: number;
  /**
   * Present only when `truncated` is true: the exact next step, so a caller that
   * only reads the payload never has to guess how to continue.
   */
  hint?: string;
}

export function estimateTokens(value: unknown): number {
  if (value === undefined) return 0;
  const text = JSON.stringify(value) ?? String(value);
  return Math.ceil(text.length / 4);
}

/**
 * Slice a list to a token budget, starting at `cursor`.
 *
 * A single item is always returned even when it exceeds the budget, so a page
 * can never come back empty while items remain.
 */
export function applyBudget<T>(items: readonly T[], opts: BudgetOptions = {}): BudgetPage<T> {
  const totalCount = items.length;
  const cursor = Math.max(0, Math.floor(opts.cursor ?? 0));
  const available = cursor >= totalCount ? [] : items.slice(cursor);
  const maxTokens = opts.maxTokens;

  if (maxTokens === undefined || maxTokens <= 0) {
    return {
      items: available,
      totalCount,
      returnedCount: available.length,
      cursor,
      truncated: false,
      estimatedTokens: estimateTokens(available),
    };
  }

  const page: T[] = [];
  let used = 0;
  for (const item of available) {
    const cost = estimateTokens(item);
    if (page.length > 0 && used + cost > maxTokens) break;
    page.push(item);
    used += cost;
  }

  const nextCursor = cursor + page.length;
  const truncated = nextCursor < totalCount;
  return {
    items: page,
    totalCount,
    returnedCount: page.length,
    cursor,
    ...(truncated ? { nextCursor } : {}),
    truncated,
    estimatedTokens: used,
  };
}

/**
 * The next step for a truncated page, phrased so it names the actual cursor
 * value rather than describing the mechanism.
 */
export function truncationHint<T>(page: BudgetPage<T>): string {
  const first = page.cursor;
  const last = page.cursor + page.returnedCount - 1;
  return (
    `Truncated: items ${first}-${last} of ${page.totalCount}. ` +
    `Pass cursor=${page.nextCursor} for the next page, raise max_tokens, ` +
    `or narrow the query with this tool's filter arguments.`
  );
}

/** Strip the items from a page so it can be attached as response metadata. */
export function pageMeta<T>(page: BudgetPage<T>): PageMeta {
  return {
    totalCount: page.totalCount,
    returnedCount: page.returnedCount,
    cursor: page.cursor,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    truncated: page.truncated,
    estimatedTokens: page.estimatedTokens,
    ...(page.truncated ? { hint: truncationHint(page) } : {}),
  };
}

/** True when the caller opted into budgeted output in any way. */
export function budgetRequested(opts: BudgetOptions): boolean {
  return opts.maxTokens !== undefined || opts.cursor !== undefined;
}
