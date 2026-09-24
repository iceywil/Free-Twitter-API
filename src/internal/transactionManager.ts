/**
 * Owns the `x-client-transaction-id` header lifecycle.
 *
 * The Python library initialises `ClientTransaction` on the first request and
 * lets any failure propagate. That is fragile in practice: the algorithm reads a
 * key-byte index table and a loading-animation SVG out of x.com's logged-out
 * home page, and x.com periodically reshapes that page — when it does, the
 * header cannot be built at all and every single request would throw.
 *
 * So initialisation failures are recorded and the header is simply omitted,
 * with one warning. Requests then proceed exactly as they would for a client
 * that never sends the header, which is strictly better than failing outright.
 * Set `requireTransactionId: true` to opt into the upstream behaviour instead.
 */

import { DOMAIN } from '../constants.js';
import { ClientTransaction } from '../transaction/transaction.js';
import type { HttpSession } from './http.js';

export interface TransactionManagerOptions {
  /** Throw instead of degrading when the header cannot be generated. */
  requireTransactionId?: boolean;
  /** Suppress the one-time warning emitted when the header is unavailable. */
  silent?: boolean;
}

/*
 * The transaction generator's inputs — the logged-out home page markup, the
 * `ondemand.s` bundle and the loading-animation SVG — are public and identical
 * for every client, and `generateTransactionId` reads them without mutating.
 * So the initialised generator is shared across every client in the process and
 * refreshed only occasionally.
 *
 * This matters a lot in bulk: `init` downloads ~1.5 MB, and a client that
 * initialised per instance re-downloaded it on *every* request. A run of tens
 * of thousands of follows was therefore tens of GB of home-page re-fetches
 * through residential proxies. Shared, it is one download per process per TTL.
 */
const SHARED_TTL_MS = 30 * 60 * 1000;
let sharedTransaction: ClientTransaction | null = null;
let sharedAt = 0;
let sharedInit: Promise<ClientTransaction> | null = null;

/**
 * The shared, initialised generator — fetched once (through the first caller's
 * session) and reused until it goes stale. Concurrent callers await the one
 * in-flight init rather than each starting their own.
 */
async function getSharedTransaction(
  session: HttpSession,
  headers: Record<string, string>
): Promise<ClientTransaction> {
  if (sharedTransaction && Date.now() - sharedAt < SHARED_TTL_MS) {
    return sharedTransaction;
  }
  if (!sharedInit) {
    sharedInit = (async () => {
      const tx = new ClientTransaction();
      const cookiesBackup = { ...session.getCookies() };
      try {
        await tx.init(session, headers);
      } finally {
        // The home-page fetch touches the caller's jar; leave it as it was.
        session.setCookies(cookiesBackup, true);
      }
      sharedTransaction = tx;
      sharedAt = Date.now();
      return tx;
    })();
    // Clear the in-flight handle whether it resolves or rejects, so a failed
    // init does not wedge every later request.
    void sharedInit.then(
      () => {
        sharedInit = null;
      },
      () => {
        sharedInit = null;
      }
    );
  }
  return sharedInit;
}

export class TransactionManager {
  private disabled = false;
  private warned = false;

  constructor(private readonly options: TransactionManagerOptions = {}) {}

  /** Whether the header is currently being omitted. */
  get unavailable(): boolean {
    return this.disabled;
  }

  /**
   * The shared generator. Initialised lazily on the first request, so before
   * then this is a fresh, empty instance rather than null.
   */
  get transaction(): ClientTransaction {
    return sharedTransaction ?? new ClientTransaction();
  }

  /**
   * Ensures the generator is initialised and adds the header to `headers`.
   * Mutates `headers` in place.
   */
  async apply(
    session: HttpSession,
    method: string,
    url: string,
    headers: Record<string, string>,
    context: { language: string; userAgent: string }
  ): Promise<void> {
    if (this.disabled) return;

    let transaction: ClientTransaction;
    try {
      const ctHeaders = {
        'Accept-Language': `${context.language},${context.language.split('-')[0]};q=0.9`,
        'Cache-Control': 'no-cache',
        Referer: `https://${DOMAIN}`,
        'User-Agent': context.userAgent,
      };
      transaction = await getSharedTransaction(session, ctHeaders);
    } catch (error) {
      this.fail(error);
      return;
    }

    try {
      headers['X-Client-Transaction-Id'] = transaction.generateTransactionId(
        method,
        new URL(url).pathname
      );
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.options.requireTransactionId) throw error;

    this.disabled = true;
    if (!this.warned && !this.options.silent) {
      this.warned = true;
      console.warn(
        `free-twitter-api: could not generate the x-client-transaction-id header ` +
          `(${(error as Error).message}); continuing without it. ` +
          `x.com has likely changed its home page markup. ` +
          `Pass requireTransactionId: true to treat this as fatal.`
      );
    }
  }
}
