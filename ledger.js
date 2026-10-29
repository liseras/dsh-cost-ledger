/**
 * Cost-ledger core: scan every Session log under `$DSH_HOME/sessions`, extract
 * the provider-reported token usage of each settled assistant step, and fold it
 * into accrual days that roll over at a local cutoff hour (default 05:00).
 *
 * Pricing follows the published DeepSeek list price: a peak tier and an off-peak
 * tier (00:30–08:30 Beijing time), judged per call by the call's own timestamp.
 *
 * Pure data: no Cordis, no HTTP, no rendering. The Host half calls
 * `createLedger()`; the Client half only sees the JSON the Host serializes.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** Zstandard frame magic, little-endian 0xFD2FB528. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Session log file names in preference order: newest format first. */
const SESSION_FILES = ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl'];

/**
 * One price row. `peak` and `offPeak` carry the four billed rates in the table
 * currency per million tokens; `cacheWrite` is billed at the `input` rate
 * because the gateway charges cached writes as ordinary prompt tokens.
 * @typedef {{ match: string, note?: string, peak: RateSet, offPeak: RateSet }} PriceRow
 * @typedef {{ input: number, cacheRead: number, output: number }} RateSet
 */

/**
 * Default standard prices in CNY per million tokens, matched against the model
 * id by substring, first row wins, the final `*` row is the fallback.
 * DeepSeek row = official list price (peak 2 / 0.04 / 8, off-peak half price at
 * 00:30–08:30 Beijing time); the higher row is the second gateway tier.
 * @type {{ currency: string, offPeakWindows: string[][], rows: PriceRow[] }}
 */
export const DEFAULT_PRICES = {
  currency: 'CNY',
  offPeakWindows: [['00:30', '08:30']],
  rows: [
    {
      match: 'deepseek',
      note: 'DeepSeek 标准价',
      peak: { input: 2, cacheRead: 0.04, output: 8 },
      offPeak: { input: 1, cacheRead: 0.02, output: 4 },
    },
    {
      match: 'glm',
      note: '网关第二档',
      peak: { input: 9, cacheRead: 0.3, output: 27 },
      offPeak: { input: 4.5, cacheRead: 0.15, output: 13.5 },
    },
    {
      match: '*',
      note: '兜底',
      peak: { input: 2, cacheRead: 0.04, output: 8 },
      offPeak: { input: 1, cacheRead: 0.02, output: 4 },
    },
  ],
};

/** Accrual day boundary hour, local time. */
export const CUTOFF_HOUR = 5;

/**
 * Accrual day key for one timestamp: days run 05:00 → 05:00 local time.
 * @param {number} ms - epoch milliseconds.
 * @param {number} cutoffHour - local hour the day rolls over.
 * @returns {string} `YYYY-MM-DD` of the accrual day the instant belongs to.
 */
export function dayKeyOf(ms, cutoffHour = CUTOFF_HOUR) {
  const date = new Date(ms);
  if (date.getHours() < cutoffHour) date.setDate(date.getDate() - 1);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Start of an accrual day in local time.
 * @param {string} key - `YYYY-MM-DD` accrual day.
 * @param {number} cutoffHour - local hour the day rolls over.
 * @returns {number} epoch milliseconds of that day's first instant.
 */
export function dayStartOf(key, cutoffHour = CUTOFF_HOUR) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, cutoffHour, 0, 0, 0).getTime();
}

/**
 * Parse a `HH:MM` clock string into minutes after midnight.
 * @param {string} text - clock text.
 * @returns {number} minutes, or NaN when malformed.
 */
function minutesOf(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (match === null) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Whether one instant falls inside any off-peak window. A window whose end is
 * not after its start wraps around midnight.
 * @param {number} ms - epoch milliseconds.
 * @param {string[][]} windows - `[start, end]` clock pairs.
 * @returns {boolean} true when the off-peak tier applies.
 */
export function isOffPeak(ms, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return false;
  const date = new Date(ms);
  const minutes = date.getHours() * 60 + date.getMinutes();
  for (const window of windows) {
    if (!Array.isArray(window) || window.length !== 2) continue;
    const start = minutesOf(window[0]);
    const end = minutesOf(window[1]);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end) return true;
  }
  return false;
}

/**
 * List one log file per Session directory, preferring the newest format.
 * @param {string} sessionsRoot - `$DSH_HOME/sessions`.
 * @returns {string[]} absolute log paths.
 */
export function listSessionLogs(sessionsRoot) {
  const out = [];
  let workspaces = [];
  try {
    workspaces = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspacePath = join(sessionsRoot, workspace.name);
    let sessions = [];
    try {
      sessions = readdirSync(workspacePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionPath = join(workspacePath, session.name);
      let names = [];
      try {
        names = readdirSync(sessionPath);
      } catch {
        continue;
      }
      const picked = SESSION_FILES.find((name) => names.includes(name));
      if (picked !== undefined) out.push(join(sessionPath, picked));
    }
  }
  return out;
}

/**
 * Decode one log file from a byte offset, appending to a parser state.
 * The log is an append-only sequence of independently compressed zstd frames,
 * so the byte offset is a safe resume point between scans.
 * @param {Buffer} buffer - complete current file bytes.
 * @param {number} offset - byte offset already consumed by a previous scan.
 * @param {Array} events - sink receiving usage records.
 * @returns {number} the offset to resume from next time.
 */
function consumeFrames(buffer, offset, events) {
  if (buffer.length === 0) return 0;
  const position = Math.max(0, Math.min(offset, buffer.length));
  const compressed = buffer.indexOf(ZSTD_MAGIC, 0) === 0;
  if (!compressed) {
    // Plaintext JSONL: consume whole lines only, so a half-written tail is
    // replayed by the next scan instead of being parsed as broken JSON.
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < position) return position;
    consumeLines(buffer.subarray(position, lastNewline + 1).toString('utf8'), events);
    return lastNewline + 1;
  }
  const starts = [];
  let index = buffer.indexOf(ZSTD_MAGIC, position);
  while (index !== -1) {
    starts.push(index);
    index = buffer.indexOf(ZSTD_MAGIC, index + 4);
  }
  if (starts.length === 0) return position;
  let resume = position;
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length;
    let text;
    try {
      text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
    } catch {
      // A trailing partial frame: leave it for the next scan.
      return start;
    }
    consumeLines(text, events);
    resume = end;
  }
  return resume;
}

/**
 * Parse JSONL text and append one usage record per assistant message.
 * @param {string} text - newline-delimited session events.
 * @param {Array} events - sink of `[time, input, output, cacheRead, cacheWrite, model]`.
 */
function consumeLines(text, events) {
  let from = 0;
  while (from < text.length) {
    let newline = text.indexOf('\n', from);
    if (newline === -1) newline = text.length;
    const line = text.slice(from, newline);
    from = newline + 1;
    if (line.length === 0 || line.charCodeAt(0) !== 0x7b) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== 'assistant/message') continue;
    const data = event.data;
    if (data === null || typeof data !== 'object') continue;
    const usage = data.usage;
    if (usage === null || typeof usage !== 'object') continue;
    const source = data.message && data.message.source;
    const model = source && typeof source.model === 'string' ? source.model : 'unknown';
    const provider = source && typeof source.provider === 'string' ? source.provider : 'unknown';
    const time = typeof event.time === 'number' ? event.time : 0;
    if (time <= 0) continue;
    events.push([
      time,
      Number(usage.inputTokens) || 0,
      Number(usage.outputTokens) || 0,
      Number(usage.cacheReadTokens) || 0,
      Number(usage.cacheWriteTokens) || 0,
      `${provider}/${model}`,
    ]);
  }
}

/**
 * Read or create the scan cache.
 * @param {string} cachePath - JSON cache location.
 * @returns {{ version: number, files: Record<string, { size: number, mtime: number, offset: number, events: Array }> }}
 */
function loadCache(cachePath) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === 'object') return parsed;
  } catch {
    /* absent or corrupt cache: rebuild */
  }
  return { version: 1, files: {} };
}

/**
 * Persist the scan cache, ignoring write failures (a cold rebuild is always possible).
 * @param {string} cachePath - JSON cache location.
 * @param {unknown} cache - cache document.
 */
function saveCache(cachePath, cache) {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
  } catch {
    /* best effort */
  }
}

/**
 * Normalize one rate set, falling back to the shipped values.
 * @param {unknown} raw - candidate rate set.
 * @param {RateSet} fallback - values used for missing numbers.
 * @returns {RateSet} four non-negative rates.
 */
function normalizeRates(raw, fallback) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const pick = (key) => {
    const value = Number(source[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback[key];
  };
  return { input: pick('input'), cacheRead: pick('cacheRead'), output: pick('output') };
}

/**
 * Upgrade a price table written by the flat single-tier format.
 * @param {object} raw - parsed price document.
 * @returns {{ currency: string, offPeakWindows: string[][], rows: PriceRow[] }} normalized table.
 */
function normalizeTable(raw) {
  const fallbackWindows = DEFAULT_PRICES.offPeakWindows.map((window) => window.slice());
  const windows = Array.isArray(raw.offPeakWindows) && raw.offPeakWindows.length > 0
    ? raw.offPeakWindows.filter((window) => Array.isArray(window) && window.length === 2).map((window) => [String(window[0]), String(window[1])])
    : fallbackWindows;
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const normalized = rows.map((row) => {
    const match = String(row && row.match !== undefined ? row.match : '*');
    if (row && row.peak !== undefined) {
      return {
        match,
        note: typeof row.note === 'string' ? row.note : '',
        peak: normalizeRates(row.peak, DEFAULT_PRICES.rows[2].peak),
        offPeak: normalizeRates(row.offPeak, DEFAULT_PRICES.rows[2].offPeak),
      };
    }
    // Legacy flat row: treat its numbers as the peak tier, half them off-peak.
    const flat = normalizeRates(row, DEFAULT_PRICES.rows[2].peak);
    return {
      match,
      note: typeof row?.note === 'string' ? row.note : '',
      peak: flat,
      offPeak: { input: flat.input / 2, cacheRead: flat.cacheRead / 2, output: flat.output / 2 },
    };
  });
  return {
    currency: typeof raw.currency === 'string' && raw.currency.length > 0 ? raw.currency : DEFAULT_PRICES.currency,
    offPeakWindows: windows,
    rows: normalized.length > 0 ? normalized : DEFAULT_PRICES.rows.map((row) => ({ ...row })),
  };
}

/**
 * Create the ledger: a cached session scan plus the derived accrual view.
 * @param {{ homeDir: string, cacheDir?: string, cutoffHour?: number }} options - filesystem roots.
 * @returns {object} ledger handle.
 */
export function createLedger(options) {
  const homeDir = options.homeDir;
  const cacheDir = options.cacheDir ?? join(homeDir, 'cost-ledger');
  const cachePath = join(cacheDir, 'scan-cache.json');
  const pricesPath = join(cacheDir, 'prices.json');
  const sessionsRoot = join(homeDir, 'sessions');
  const cutoffHour = options.cutoffHour ?? CUTOFF_HOUR;

  let cache = loadCache(cachePath);
  const state = {
    scanning: false,
    scannedAt: 0,
    lastDurationMs: 0,
    lastFiles: 0,
    lastNewFiles: 0,
    error: null,
  };

  /**
   * Let the Host event loop breathe between log files: one large Session log can
   * take most of a second to inflate, so the scan must not monopolise it.
   * @returns {Promise<void>} resolves on the next macrotask.
   */
  function yieldToLoop() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Rescan every log incrementally. Files whose size and mtime are unchanged are
   * reused; changed files are replayed from their recorded offset.
   * @returns {Promise<{ events: Array, durationMs: number, files: number, rescanned: number }>} scan result.
   */
  async function scan() {
    const started = Date.now();
    const logs = listSessionLogs(sessionsRoot);
    const next = { version: 1, files: {} };
    let rescanned = 0;
    for (const log of logs) {
      let info;
      try {
        info = statSync(log);
      } catch {
        continue;
      }
      const previous = cache.files[log];
      if (previous !== undefined && previous.size === info.size && previous.mtime === info.mtimeMs) {
        next.files[log] = previous;
        continue;
      }
      let buffer;
      try {
        buffer = readFileSync(log);
      } catch {
        if (previous !== undefined) next.files[log] = previous;
        continue;
      }
      const resumeFrom = previous !== undefined && previous.size <= info.size ? previous.offset : 0;
      const events = resumeFrom > 0 && previous !== undefined ? previous.events.slice() : [];
      let offset = 0;
      try {
        offset = consumeFrames(buffer, resumeFrom, events);
      } catch {
        offset = resumeFrom;
      }
      next.files[log] = { size: info.size, mtime: info.mtimeMs, offset, events };
      rescanned += 1;
      await yieldToLoop();
    }
    cache = next;
    saveCache(cachePath, cache);
    const events = [];
    for (const file of Object.keys(cache.files)) {
      const entry = cache.files[file];
      for (const event of entry.events) events.push(event);
    }
    state.scannedAt = Date.now();
    state.lastDurationMs = Date.now() - started;
    state.lastFiles = logs.length;
    state.lastNewFiles = rescanned;
    state.error = null;
    return { events, durationMs: state.lastDurationMs, files: logs.length, rescanned };
  }

  /**
   * Load the price table, creating the default file on first use.
   * @returns {{ currency: string, offPeakWindows: string[][], rows: PriceRow[] }}
   */
  function readPrices() {
    try {
      const parsed = JSON.parse(readFileSync(pricesPath, 'utf8'));
      if (parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0) {
        const table = normalizeTable(parsed);
        if (parsed.offPeakWindows === undefined || parsed.rows[0].peak === undefined) writePrices(table);
        return table;
      }
    } catch {
      /* fall through to the shipped defaults */
    }
    const defaults = normalizeTable(DEFAULT_PRICES);
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(pricesPath, JSON.stringify(defaults, null, 2), 'utf8');
    } catch {
      /* best effort */
    }
    return defaults;
  }

  /**
   * Replace the price table.
   * @param {{ currency?: string, offPeakWindows?: string[][], rows: PriceRow[] }} table - candidate table.
   * @returns {{ currency: string, offPeakWindows: string[][], rows: PriceRow[] }} normalized table now in effect.
   */
  function writePrices(table) {
    const clean = normalizeTable(table);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(pricesPath, JSON.stringify(clean, null, 2), 'utf8');
    return clean;
  }

  /**
   * Resolve the price row for one provider/model id.
   * @param {string} modelId - `provider/model`.
   * @param {{ rows: PriceRow[] }} table - price table in effect.
   * @returns {{ row: PriceRow, matched: boolean }}
   */
  function priceFor(modelId, table) {
    const lower = String(modelId).toLowerCase();
    for (const row of table.rows) {
      const needle = String(row.match ?? '').toLowerCase();
      if (needle === '*' || needle.length === 0) continue;
      if (lower.includes(needle)) return { row, matched: true };
    }
    const fallback = table.rows.find((row) => String(row.match) === '*') ?? table.rows[table.rows.length - 1];
    return { row: fallback, matched: false };
  }

  /**
   * Cost of one usage record in the table's currency, at the tier the call's own
   * timestamp falls into. Cached writes bill at the input rate.
   * @param {Array} event - `[time, input, output, cacheRead, cacheWrite, model]`.
   * @param {{ rows: PriceRow[], offPeakWindows: string[][] }} table - price table in effect.
   * @returns {number} cost, per million tokens.
   */
  function costOf(event, table) {
    const { row } = priceFor(event[5], table);
    const tier = isOffPeak(event[0], table.offPeakWindows) ? row.offPeak : row.peak;
    const prompt = (event[1] + event[4]) * tier.input;
    const cached = event[3] * tier.cacheRead;
    const output = event[2] * tier.output;
    return (prompt + cached + output) / 1_000_000;
  }

  /**
   * Fold the scanned events into per-day, per-model totals.
   * @param {Array} events - usage records from the scan.
   * @param {{ currency: string, rows: PriceRow[], offPeakWindows: string[][] }} table - price table in effect.
   * @returns {object} the serializable ledger view.
   */
  function summarize(events, table) {
    const days = new Map();
    const models = new Map();
    for (const event of events) {
      const key = dayKeyOf(event[0], cutoffHour);
      let day = days.get(key);
      if (day === undefined) {
        day = { key, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, models: new Map() };
        days.set(key, day);
      }
      const cost = costOf(event, table);
      day.cost += cost;
      day.input += event[1];
      day.output += event[2];
      day.cacheRead += event[3];
      day.cacheWrite += event[4];
      day.calls += 1;
      const modelId = event[5];
      let model = day.models.get(modelId);
      if (model === undefined) {
        model = { id: modelId, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
        day.models.set(modelId, model);
      }
      model.cost += cost;
      model.input += event[1];
      model.output += event[2];
      model.cacheRead += event[3];
      model.cacheWrite += event[4];
      model.calls += 1;
      let all = models.get(modelId);
      if (all === undefined) {
        all = { id: modelId, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
        models.set(modelId, all);
      }
      all.cost += cost;
      all.input += event[1];
      all.output += event[2];
      all.cacheRead += event[3];
      all.cacheWrite += event[4];
      all.calls += 1;
    }
    const ordered = [...days.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    return { days: ordered, models: [...models.values()], currency: table.currency };
  }

  return {
    state,
    scan,
    readPrices,
    writePrices,
    priceFor,
    costOf,
    summarize,
    dayKeyOf: (ms) => dayKeyOf(ms, cutoffHour),
    dayStartOf: (key) => dayStartOf(key, cutoffHour),
    cutoffHour,
    homeDir,
    sessionsRoot,
    cacheDir,
    cachePath,
  };
}
