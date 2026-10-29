/**
 * Host half of the cost ledger.
 *
 * The provider this profile talks to (a gateway in front of DeepSeek / GLM)
 * exposes no usage or balance endpoint, so the ledger is kept from the one
 * source that is already on disk: every Session log under `$DSH_HOME/sessions`.
 * Each settled assistant step carries the provider-reported `TokenUsage`, and
 * the file path is workspace-independent — so the total covers every window,
 * every workspace and every child agent that ran on this machine.
 *
 * Rendering lives in `client.js`; this half only answers JSON over same-origin
 * HTTP routes, which keeps the browser half free of filesystem access.
 */
import { createLedger, DEFAULT_PRICES } from './ledger.js';

/** Route prefix owned by this plugin. Distinct paths keep composition collisions impossible. */
const PREFIX = '/cost-ledger/api';

/** Minimum gap between two automatic rescans, in milliseconds. */
const REFRESH_THROTTLE_MS = 1_500;

/** How long a completed scan is served without rescanning, in milliseconds. */
const CACHE_TTL_MS = 20_000;

/**
 * Resolve the Harness home directory the same way the CLI does.
 * @returns {string} absolute `$DSH_HOME`.
 */
function resolveHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  return `${home}/.dsh`;
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - response to complete.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serializable payload.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Read a request body as UTF-8 text.
 * @param {import('node:http').IncomingMessage} req - request to drain.
 * @param {number} limit - maximum accepted byte count.
 * @returns {Promise<string>} the body text.
 */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Build the rolling windows the panel shows.
 * @param {object} ledger - ledger handle.
 * @param {object} view - summarized view.
 * @param {number} now - current epoch milliseconds.
 * @returns {object} summary payload.
 */
function buildSummary(ledger, view, now) {
  const todayKey = ledger.dayKeyOf(now);
  const byKey = new Map(view.days.map((day) => [day.key, day]));
  const empty = { key: '', cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  const read = (key) => byKey.get(key) ?? { ...empty, key };

  const yesterdayKey = ledger.dayKeyOf(now - 24 * 3_600_000);
  const days = [];
  for (let offset = Math.max(0, 89); offset >= 0; offset -= 1) {
    const key = ledger.dayKeyOf(now - offset * 24 * 3_600_000);
    if (key !== days[days.length - 1]) days.push(key);
  }
  const series = days.map((key) => read(key));

  const sum = (keys) => keys.reduce((total, key) => {
    const day = read(key);
    total.cost += day.cost;
    total.input += day.input;
    total.output += day.output;
    total.cacheRead += day.cacheRead;
    total.cacheWrite += day.cacheWrite;
    total.calls += day.calls;
    return total;
  }, { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });

  const last7 = days.slice(-7);
  const last30 = days.slice(-30);
  const monthPrefix = todayKey.slice(0, 7);
  const monthKeys = view.days.filter((day) => day.key.startsWith(monthPrefix)).map((day) => day.key);

  // Weeks start on Monday, still inside the 05:00 accrual boundary.
  const weekBuckets = new Map();
  for (const day of view.days) {
    const [y, m, d] = day.key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const weekday = (date.getDay() + 6) % 7;
    const monday = new Date(date.getTime() - weekday * 86_400_000);
    const weekKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const bucket = weekBuckets.get(weekKey) ?? { key: weekKey, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
    bucket.cost += day.cost;
    bucket.input += day.input;
    bucket.output += day.output;
    bucket.cacheRead += day.cacheRead;
    bucket.cacheWrite += day.cacheWrite;
    bucket.calls += day.calls;
    weekBuckets.set(weekKey, bucket);
  }
  const weeks = [...weekBuckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).slice(-12);

  const today = read(todayKey);
  const lifetime = view.days.reduce((total, day) => {
    total.cost += day.cost;
    total.input += day.input;
    total.output += day.output;
    total.cacheRead += day.cacheRead;
    total.cacheWrite += day.cacheWrite;
    total.calls += day.calls;
    return total;
  }, { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });

  return {
    ready: true,
    now,
    currency: view.currency,
    cutoffHour: ledger.cutoffHour,
    today: {
      key: todayKey,
      ...today,
      models: [...(view.days.find((day) => day.key === todayKey)?.models?.values() ?? [])].map((model) => ({ ...model })),
    },
    yesterday: read(yesterdayKey),
    last7: sum(last7),
    last30: sum(last30),
    month: sum(monthKeys),
    lifetime,
    series,
    weeks,
    models: view.models,
  };
}

/**
 * Host plugin body.
 * @param {object} ctx - Cordis context.
 */
export function apply(ctx) {
  const ledger = createLedger({ homeDir: resolveHome() });
  let lastScanAt = 0;
  let lastEvents = null;
  let scanError = null;
  /** @type {Promise<unknown> | null} */
  let scanTask = null;

  /**
   * Kick a background rescan. The scan is chunked per log file, so the event
   * loop keeps answering while the first full pass runs.
   * @returns {Promise<unknown>} the in-flight scan.
   */
  function startScan() {
    if (scanTask !== null) return scanTask;
    scanTask = ledger
      .scan()
      .then((result) => {
        lastEvents = result.events;
        lastScanAt = Date.now();
        scanError = null;
        return result;
      })
      .catch((error) => {
        scanError = String(error && error.message ? error.message : error);
      })
      .finally(() => {
        scanTask = null;
      });
    return scanTask;
  }

  /**
   * Serialize the current view. A scan may be running; the payload then carries
   * the previous numbers plus the progress flag, so the panel never blocks.
   * @returns {object} summary payload.
   */
  function snapshot() {
    const prices = ledger.readPrices();
    const summary = buildSummary(ledger, ledger.summarize(lastEvents ?? [], prices), Date.now());
    summary.ready = lastEvents !== null;
    summary.prices = prices;
    summary.scan = {
      scanning: scanTask !== null,
      scannedAt: lastScanAt,
      durationMs: ledger.state.lastDurationMs,
      files: ledger.state.lastFiles,
      rescanned: ledger.state.lastNewFiles,
      error: scanError ?? ledger.state.error,
      logs: lastEvents === null ? 0 : lastEvents.length,
      home: ledger.homeDir,
      cache: ledger.cachePath,
      ready: lastEvents !== null,
    };
    return summary;
  }

  /**
   * Start a scan when the current numbers are missing or stale.
   * @param {boolean} force - scan regardless of the cache age.
   */
  function considerScan(force) {
    if (scanTask !== null) return;
    if (force || lastEvents === null || Date.now() - lastScanAt >= CACHE_TTL_MS) startScan();
  }

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = url.pathname.slice(PREFIX.length);
        try {
          if (req.method === 'GET' && (route === '/summary' || route === '/')) {
            considerScan(false);
            sendJson(res, 200, snapshot());
            return;
          }
          if (req.method === 'POST' && route === '/refresh') {
            await startScan();
            sendJson(res, 200, snapshot());
            return;
          }
          if (route === '/prices') {
            if (req.method === 'GET') {
              sendJson(res, 200, ledger.readPrices());
              return;
            }
            if (req.method === 'POST') {
              const text = await readBody(req);
              const parsed = JSON.parse(text);
              if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.rows) || parsed.rows.length === 0) {
                sendJson(res, 400, { error: '价表需要至少一行（rows 数组）' });
                return;
              }
              sendJson(res, 200, ledger.writePrices(parsed));
              return;
            }
          }
          if (req.method === 'POST' && route === '/reset-prices') {
            sendJson(res, 200, ledger.writePrices({ currency: DEFAULT_PRICES.currency, rows: DEFAULT_PRICES.rows }));
            return;
          }
          sendJson(res, 404, { error: `未知接口 ${route}` });
        } catch (error) {
          sendJson(res, 500, { error: String(error && error.message ? error.message : error) });
        }
      },
    }), 'cost-ledger: routes');
  });
}

