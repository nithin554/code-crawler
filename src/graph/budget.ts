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

/** Strip the items from a page so it can be attached as response metadata. */
export function pageMeta<T>(page: BudgetPage<T>): PageMeta {
  return {
    totalCount: page.totalCount,
    returnedCount: page.returnedCount,
    cursor: page.cursor,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    truncated: page.truncated,
    estimatedTokens: page.estimatedTokens,
  };
}

/** True when the caller opted into budgeted output in any way. */
export function budgetRequested(opts: BudgetOptions): boolean {
  return opts.maxTokens !== undefined || opts.cursor !== undefined;
}
