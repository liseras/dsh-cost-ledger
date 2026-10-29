/**
 * Client half of the cost ledger: the desk-pet widget.
 *
 * A compact pill parked in the bottom-right corner shows today's spend; a click
 * opens a panel with the day's breakdown, the 30-day and 12-week curves, and an
 * editable price table. Every number comes from the Host half's JSON routes —
 * this half never touches the filesystem.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-spend-ledger',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'cost-ledger';
    /** Polling cadence while the panel is closed. */
    const IDLE_POLL_MS = 60_000;
    /** Polling cadence while the panel is open. */
    const OPEN_POLL_MS = 20_000;

    const zh = {
      title: '消费账本',
      'tab.today': '概览',
      'tab.curve': '曲线',
      'tab.prices': '价表',
      'label.today': '今日',
      'label.yesterday': '昨日',
      'label.last7': '近 7 天',
      'label.last30': '近 30 天',
      'label.month': '本账务月',
      'label.lifetime': '累计',
      'label.calls': '次调用',
      'label.model': '模型',
      'label.cost': '花费',
      'label.day': '日期',
      'label.week': '周（周一起）',
      'label.input': '输入',
      'label.cacheRead': '缓存命中',
      'label.cacheWrite': '缓存写入',
      'label.output': '输出',
      'label.byModel': '今日按模型',
      'label.last7detail': '近 7 天明细',
      'label.cutoff': '每天 {hour}:00 日切',
      'scan.running': '正在统计会话日志…',
      'scan.first': '首次统计需要约 30 秒，之后增量秒级完成',
      'scan.done': '已统计 {files} 个会话日志，用时 {ms}ms',
      'scan.error': '统计失败：{message}',
      'empty': '还没有消耗记录',
      'refresh': '立即重算',
      'close': '收起',
      'prices.hint': '元/百万 token，按模型名包含匹配',
      'prices.peak': '高峰',
      'prices.offPeak': '空闲',
      'prices.inputMiss': '输入(未命中)',
      'prices.offPeakWindow': '空闲时段',
      'prices.match': '模型匹配',
      'prices.save': '保存价表',
      'prices.saved': '价表已保存',
      'prices.reset': '恢复默认',
      'prices.add': '添加一行',
      'prices.remove': '删除',
      'prices.invalid': '每一行都要填模型匹配关键字和四个非负单价',
      'prices.currency': '单位',
      'curve.day30': '近 30 天每日花费',
      'curve.week12': '近 12 周花费',
      'unit.million': '元 / 百万 token',
      'tip.open': '点击查看消费明细',
    };

    const en = {
      title: 'Spend ledger',
      'tab.today': 'Today',
      'tab.curve': 'Curves',
      'tab.prices': 'Prices',
      'label.today': 'Today',
      'label.yesterday': 'Yesterday',
      'label.last7': 'Last 7 days',
      'label.last30': 'Last 30 days',
      'label.month': 'This billing month',
      'label.lifetime': 'Lifetime',
      'label.calls': 'calls',
      'label.model': 'Model',
      'label.cost': 'Cost',
      'label.day': 'Day',
      'label.week': 'Week (from Monday)',
      'label.input': 'Input',
      'label.cacheRead': 'Cache read',
      'label.cacheWrite': 'Cache write',
      'label.output': 'Output',
      'label.byModel': 'Today by model',
      'label.last7detail': 'Last 7 days',
      'label.cutoff': 'Days roll over at {hour}:00',
      'scan.running': 'Scanning session logs…',
      'scan.first': 'The first pass takes about 30 seconds; later passes are incremental',
      'scan.done': 'Scanned {files} session logs in {ms}ms',
      'scan.error': 'Scan failed: {message}',
      'empty': 'No usage recorded yet',
      'refresh': 'Rescan now',
      'close': 'Collapse',
      'prices.hint': 'CNY per million tokens, matched by model id',
      'prices.peak': 'Peak',
      'prices.offPeak': 'Off-peak',
      'prices.inputMiss': 'Input (miss)',
      'prices.offPeakWindow': 'Off-peak window',
      'prices.match': 'Model match',
      'prices.save': 'Save prices',
      'prices.saved': 'Prices saved',
      'prices.reset': 'Restore defaults',
      'prices.add': 'Add row',
      'prices.remove': 'Remove',
      'prices.invalid': 'Every row needs a match key and four non-negative prices',
      'prices.currency': 'Currency',
      'curve.day30': 'Daily spend, last 30 days',
      'curve.week12': 'Weekly spend, last 12 weeks',
      'unit.million': 'CNY / million tokens',
      'tip.open': 'Open the spend ledger',
    };

    /** Deep navy header and cyan accent follow the app's established palette. */
    const PALETTE = {
      navy: '#172B4D',
      navySoft: '#22375E',
      cyan: '#17A2B8',
      cyanSoft: 'rgba(23, 162, 184, 0.14)',
      amber: '#F5A524',
      text: 'var(--dsw-alias-label-primary, #1f2329)',
      sub: 'var(--dsw-alias-label-tertiary, #7a8494)',
      card: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      border: 'var(--dsw-alias-border-l2, #e3e8ef)',
      track: 'var(--dsw-alias-bg-layer-2, #f2f5f9)',
    };

    /**
     * Group an integer with separators.
     * @param {number} value - raw count.
     * @returns {string} display text.
     */
    function formatCount(value) {
      return Math.round(value).toLocaleString('en-US');
    }

    /**
     * Compact token count: 999, 12.4k, 3.1M, 1.2B.
     * @param {number} value - token count.
     * @returns {string} display text.
     */
    function formatTokens(value) {
      const n = Number(value) || 0;
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
      return String(Math.round(n));
    }

    /**
     * Money with two decimals, grouped above a thousand.
     * @param {number} value - amount in the table currency.
     * @returns {string} display text.
     */
    function formatMoney(value) {
      const n = Number(value) || 0;
      if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return n.toFixed(2);
    }

    /**
     * `10-28` style short label from an accrual day key.
     * @param {string} key - `YYYY-MM-DD`.
     * @returns {string} month-day.
     */
    function shortDay(key) {
      return typeof key === 'string' && key.length >= 10 ? key.slice(5) : key;
    }

    /**
     * `09-29~10-05` style week label.
     * @param {string} key - Monday date `YYYY-MM-DD`.
     * @returns {string} label.
     */
    function weekLabel(key) {
      if (typeof key !== 'string' || key.length < 10) return key;
      const start = new Date(`${key}T00:00:00`);
      const end = new Date(start.getTime() + 6 * 86_400_000);
      const md = (date) => `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      return `${md(start)}~${md(end)}`;
    }

    /**
     * Read the ledger summary from the Host half.
     * @param {string} path - route under `/cost-ledger/api`.
     * @param {object} [init] - fetch options.
     * @returns {Promise<any>} parsed JSON.
     */
    async function request(path, init) {
      const response = await fetch(`/cost-ledger/api${path}`, { cache: 'no-store', ...init });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`);
      }
      if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`);
      return body;
    }

    /** Small coin with a yuan mark, drawn rather than imported. */
    function CoinIcon(props) {
      const size = props.size ?? 16;
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, focusable: 'false' },
        h('circle', { cx: 12, cy: 12, r: 10, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, opacity: 0.5 }),
        h('path', {
          d: 'M8 7l4 5.2L16 7M12 12.2V17M8.6 12.6h6.8M8.6 14.9h6.8',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
      );
    }

    /**
     * Area+line chart of one numeric series.
     * @param props - `series` of `{ label, value }`, `height`.
     */
    function LineChart(props) {
      const series = Array.isArray(props.series) ? props.series : [];
      const width = 352;
      const height = props.height ?? 108;
      const padTop = 10;
      const padBottom = 18;
      const inner = height - padTop - padBottom;
      const max = Math.max(0.01, ...series.map((item) => item.value));
      const step = series.length > 1 ? width / (series.length - 1) : width;
      const points = series.map((item, index) => {
        const x = index * step;
        const y = padTop + inner - (item.value / max) * inner;
        return { x, y, ...item };
      });
      const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
      const area = points.length > 0
        ? `M0,${padTop + inner} ${line.replaceAll(' ', ' L')} L${width},${padTop + inner} Z`
        : '';
      const [active, setActive] = React.useState(null);
      return h(
        'div',
        { style: { position: 'relative' } },
        h(
          'svg',
          { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' },
          h('defs', null,
            h('linearGradient', { id: 'cl-area', x1: '0', y1: '0', x2: '0', y2: '1' },
              h('stop', { offset: '0%', stopColor: PALETTE.cyan, stopOpacity: 0.28 }),
              h('stop', { offset: '100%', stopColor: PALETTE.cyan, stopOpacity: 0.02 }))),
          h('line', { x1: 0, y1: padTop + inner, x2: width, y2: padTop + inner, stroke: PALETTE.border, strokeWidth: 1 }),
          area ? h('path', { d: area, fill: 'url(#cl-area)' }) : null,
          points.length > 1
            ? h('polyline', { points: line, fill: 'none', stroke: PALETTE.cyan, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' })
            : null,
          points.map((point) => h(
            'g',
            { key: point.label },
            h('circle', { cx: point.x, cy: point.y, r: active === point.label ? 3.6 : 2.1, fill: PALETTE.cyan }),
            h('rect', {
              x: point.x - step / 2,
              y: 0,
              width: step,
              height,
              fill: 'transparent',
              onMouseEnter: () => setActive(point.label),
              onMouseLeave: () => setActive(null),
            }),
          )),
          series.length > 0
            ? h('text', { x: 0, y: height - 4, fontSize: 9, fill: PALETTE.sub }, shortDay(series[0].label))
            : null,
          series.length > 1
            ? h(
              'text',
              { x: width, y: height - 4, fontSize: 9, fill: PALETTE.sub, textAnchor: 'end' },
              shortDay(series[series.length - 1].label),
            )
            : null,
        ),
        active === null
          ? null
          : h(
            'div',
            {
              style: {
                position: 'absolute',
                top: 0,
                right: 0,
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 999,
                background: PALETTE.navy,
                color: '#fff',
                whiteSpace: 'nowrap',
              },
            },
            `${active} ¥${formatMoney(series.find((item) => item.label === active)?.value ?? 0)}`,
          ),
      );
    }

    /**
     * Bar chart for weekly or daily buckets.
     * @param props - `series` of `{ label, text, value }`, `height`.
     */
    function BarChart(props) {
      const series = Array.isArray(props.series) ? props.series : [];
      const width = 352;
      const height = props.height ?? 118;
      const padBottom = 22;
      const inner = height - padBottom - 6;
      const max = Math.max(0.01, ...series.map((item) => item.value));
      const slot = series.length > 0 ? width / series.length : width;
      const barWidth = Math.max(3, Math.min(18, slot * 0.56));
      const [active, setActive] = React.useState(null);
      return h(
        'div',
        { style: { position: 'relative' } },
        h(
          'svg',
          { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' },
          h('line', { x1: 0, y1: inner + 6, x2: width, y2: inner + 6, stroke: PALETTE.border, strokeWidth: 1 }),
          series.map((item, index) => {
            const barHeight = Math.max(1, (item.value / max) * inner);
            const x = index * slot + (slot - barWidth) / 2;
            const y = 6 + inner - barHeight;
            const on = active === item.label;
            return h(
              'g',
              {
                key: item.label,
                onMouseEnter: () => setActive(item.label),
                onMouseLeave: () => setActive(null),
              },
              h('rect', {
                x,
                y,
                width: barWidth,
                height: barHeight,
                rx: Math.min(3, barWidth / 2),
                fill: on ? PALETTE.navy : PALETTE.cyan,
                opacity: on ? 1 : 0.82,
              }),
              index % Math.max(1, Math.ceil(series.length / 6)) === 0
                ? h(
                  'text',
                  {
                    x: x + barWidth / 2,
                    y: height - 8,
                    fontSize: 9,
                    fill: PALETTE.sub,
                    textAnchor: 'middle',
                  },
                  item.text,
                )
                : null,
            );
          }),
        ),
        active === null
          ? null
          : h(
            'div',
            {
              style: {
                position: 'absolute',
                top: 0,
                right: 0,
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 999,
                background: PALETTE.navy,
                color: '#fff',
                whiteSpace: 'nowrap',
              },
            },
            `${series.find((item) => item.label === active)?.text ?? ''} ¥${formatMoney(
              series.find((item) => item.label === active)?.value ?? 0,
            )}`,
          ),
      );
    }

    /**
     * One label/value row.
     * @param props - `label`, `value`, `muted`.
     */
    function Row(props) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
            padding: '5px 0',
            fontSize: 12.5,
            color: props.muted ? PALETTE.sub : PALETTE.text,
          },
        },
        h('span', { style: { color: PALETTE.sub, flex: 'none' } }, props.label),
        h('span', { style: { fontVariantNumeric: 'tabular-nums', textAlign: 'right' } }, props.value),
      );
    }

    /**
     * The panel: header, tabs, and the three views.
     * @param props - `data`, `onRefresh`, `onClose`, `t`.
     */
    function Panel(props) {
      const t = props.t;
      const data = props.data;
      const [tab, setTab] = React.useState('today');
      const [prices, setPrices] = React.useState(null);
      const [saved, setSaved] = React.useState('');

      React.useEffect(() => {
        if (tab !== 'prices' || prices !== null || data === null) return;
        setPrices(JSON.parse(JSON.stringify(data.prices)));
      }, [tab, prices, data]);

      const today = data?.ready ? data.today : null;
      const scan = data?.scan ?? null;
      const notReady = data === null || data.ready !== true;

      const tabs = [
        { id: 'today', label: t('tab.today') },
        { id: 'curve', label: t('tab.curve') },
        { id: 'prices', label: t('tab.prices') },
      ];

      /**
       * Persist the edited price table.
       */
      async function savePrices() {
        if (prices === null) return;
        const num = (value) => Number(value);
        const rows = prices.rows.map((row) => ({
          match: String(row.match ?? ''),
          note: row.note ?? '',
          peak: {
            input: num(row.peak?.input),
            cacheRead: num(row.peak?.cacheRead),
            output: num(row.peak?.output),
          },
          offPeak: {
            input: num(row.offPeak?.input),
            cacheRead: num(row.offPeak?.cacheRead),
            output: num(row.offPeak?.output),
          },
        }));
        const valid = (rate) => ['input', 'cacheRead', 'output'].every(
          (key) => Number.isFinite(rate[key]) && rate[key] >= 0,
        );
        const bad = rows.some((row) => row.match.trim().length === 0 || !valid(row.peak) || !valid(row.offPeak));
        if (bad) {
          setSaved(t('prices.invalid'));
          return;
        }
        try {
          const next = await request('/prices', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              currency: prices.currency,
              offPeakWindows: prices.offPeakWindows,
              rows,
            }),
          });
          setPrices(JSON.parse(JSON.stringify(next)));
          setSaved(t('prices.saved'));
          props.onRefresh();
        } catch (error) {
          setSaved(String(error && error.message ? error.message : error));
        }
      }

      const header = h(
        'div',
        {
          style: {
            background: `linear-gradient(135deg, ${PALETTE.navy} 0%, ${PALETTE.navySoft} 100%)`,
            color: '#fff',
            padding: '12px 16px 10px',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
          },
        },
        h(
          'div',
          null,
          h('div', { style: { fontSize: 13, fontWeight: 600, letterSpacing: '0.04em', opacity: 0.92 } }, t('title')),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 } },
            h('span', { style: { fontSize: 24, fontWeight: 700, fontVariantNumeric: 'tabular-nums' } },
              `¥${formatMoney(today?.cost ?? 0)}`),
            h('span', { style: { fontSize: 11, opacity: 0.72 } }, `${t('label.today')} · ${formatCount(today?.calls ?? 0)} ${t('label.calls')}`),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: props.onClose,
            title: t('close'),
            style: {
              border: '1px solid rgba(255,255,255,0.28)',
              background: 'transparent',
              color: '#fff',
              borderRadius: 6,
              fontSize: 11,
              padding: '2px 8px',
              cursor: 'pointer',
            },
          },
          t('close'),
        ),
      );

      const tabBar = h(
        'div',
        { style: { display: 'flex', gap: 4, padding: '8px 12px 0', borderBottom: `1px solid ${PALETTE.border}` } },
        tabs.map((item) => h(
          'button',
          {
            key: item.id,
            type: 'button',
            onClick: () => setTab(item.id),
            style: {
              border: 'none',
              borderBottom: `2px solid ${tab === item.id ? PALETTE.cyan : 'transparent'}`,
              background: 'transparent',
              color: tab === item.id ? PALETTE.navy : PALETTE.sub,
              fontWeight: tab === item.id ? 600 : 500,
              fontSize: 12.5,
              padding: '6px 10px 7px',
              cursor: 'pointer',
            },
          },
          item.label,
        )),
      );

      let body = null;

      if (notReady) {
        const debugLine = scan === null
          ? null
          : `ready=${String(scan.ready)} scanning=${String(scan.scanning)} files=${String(scan.files)} events=${String(scan.logs)} err=${String(scan.error)} home=${String(scan.home)}`;
        body = h(
          'div',
          { style: { padding: '26px 16px', fontSize: 12.5, color: PALETTE.sub, lineHeight: 1.7 } },
          h('div', null, data?.error ? String(data.error) : t('scan.running')),
          h('div', { style: { fontSize: 11.5, opacity: 0.8, wordBreak: 'break-all' } }, t('scan.first')),
          debugLine === null ? null : h('div', {
            style: { fontSize: 10.5, opacity: 0.75, marginTop: 8, wordBreak: 'break-all', fontFamily: 'monospace' },
          }, debugLine),
        );
      } else if (tab === 'today') {
        const models = today?.models ?? [];
        const recent = (data.series ?? []).slice(-7).reverse();
        body = h(
          'div',
          { style: { padding: '10px 16px 14px' } },
          h('div', null,
            h(Row, { label: t('label.yesterday'), value: `¥${formatMoney(data.yesterday?.cost ?? 0)}` }),
            h(Row, { label: t('label.last7'), value: `¥${formatMoney(data.last7?.cost ?? 0)}` }),
            h(Row, { label: t('label.last30'), value: `¥${formatMoney(data.last30?.cost ?? 0)}` }),
            h(Row, { label: t('label.month'), value: `¥${formatMoney(data.month?.cost ?? 0)}` }),
            h(Row, { label: t('label.lifetime'), value: `¥${formatMoney(data.lifetime?.cost ?? 0)}` }),
          ),
          h('div', {
            style: { height: 1, background: PALETTE.border, margin: '8px 0 4px' },
          }),
          h(Row, {
            label: t('label.input'),
            value: formatTokens(today?.input ?? 0),
            muted: true,
          }),
          h(Row, {
            label: t('label.cacheRead'),
            value: formatTokens(today?.cacheRead ?? 0),
            muted: true,
          }),
          h(Row, {
            label: t('label.output'),
            value: formatTokens(today?.output ?? 0),
            muted: true,
          }),
          h('div', {
            style: { fontSize: 11.5, fontWeight: 600, color: PALETTE.navy, margin: '12px 0 4px' },
          }, t('label.byModel')),
          models.length === 0
            ? h('div', { style: { fontSize: 12, color: PALETTE.sub } }, t('empty'))
            : h(
              'div',
              null,
              models
                .slice()
                .sort((a, b) => b.cost - a.cost)
                .map((model) => h(Row, {
                  key: model.id,
                  label: model.id,
                  value: `¥${formatMoney(model.cost)} · ${formatCount(model.calls)} ${t('label.calls')}`,
                })),
            ),
          h('div', {
            style: { fontSize: 11.5, fontWeight: 600, color: PALETTE.navy, margin: '12px 0 4px' },
          }, t('label.last7detail')),
          h(
            'div',
            null,
            recent.length === 0
              ? h('div', { style: { fontSize: 12, color: PALETTE.sub } }, t('empty'))
              : recent.map((day) => h(Row, {
                key: day.key,
                label: day.key,
                value: `¥${formatMoney(day.cost)} · ${formatCount(day.calls)} ${t('label.calls')}`,
              })),
          ),
        );
      } else if (tab === 'curve') {
        const days = (data.series ?? []).slice(-30).map((day) => ({ label: day.key, value: day.cost }));
        const weeks = (data.weeks ?? []).map((week) => ({
          label: week.key,
          text: weekLabel(week.key),
          value: week.cost,
        }));
        body = h(
          'div',
          { style: { padding: '12px 16px 16px' } },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: PALETTE.navy, marginBottom: 6 } }, t('curve.day30')),
          h(LineChart, { series: days }),
          h('div', { style: { fontSize: 12, fontWeight: 600, color: PALETTE.navy, margin: '14px 0 6px' } }, t('curve.week12')),
          h(BarChart, { series: weeks }),
          h('div', {
            style: { fontSize: 11, color: PALETTE.sub, marginTop: 10 },
          }, t('label.cutoff', { hour: data.cutoffHour })),
        );
      } else {
        const table = prices ?? { currency: 'CNY', offPeakWindows: [['00:30', '08:30']], rows: [] };
        const windows = Array.isArray(table.offPeakWindows) && table.offPeakWindows.length > 0
          ? table.offPeakWindows
          : [['00:30', '08:30']];
        const primary = windows[0];
        const rows = table.rows ?? [];
        const field = {
          width: '100%',
          boxSizing: 'border-box',
          fontSize: 12.5,
          padding: '5px 8px',
          border: `1px solid ${PALETTE.border}`,
          borderRadius: 6,
          background: PALETTE.card,
          color: PALETTE.text,
          fontVariantNumeric: 'tabular-nums',
        };
        const muted = { fontSize: 11, color: PALETTE.sub };

        const update = (mutate) => {
          const next = JSON.parse(JSON.stringify(table));
          mutate(next);
          setPrices(next);
        };

        body = h(
          'div',
          { style: { padding: '12px 16px 16px' } },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 } },
            h('span', { style: muted }, `${t('unit.million')} · ${table.currency ?? 'CNY'}`),
            h('span', { style: { ...muted, textAlign: 'right' } }, t('prices.hint')),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 } },
            h('span', { style: muted }, t('prices.offPeakWindow')),
            h('input', {
              value: primary?.[0] ?? '00:30',
              maxLength: 5,
              onChange: (event) => update((next) => { next.offPeakWindows[0][0] = event.target.value; }),
              style: { ...field, width: 64, textAlign: 'center' },
            }),
            h('span', { style: muted }, '→'),
            h('input', {
              value: primary?.[1] ?? '08:30',
              maxLength: 5,
              onChange: (event) => update((next) => { next.offPeakWindows[0][1] = event.target.value; }),
              style: { ...field, width: 64, textAlign: 'center' },
            }),
          ),
          rows.map((row, index) => h(
            'div',
            {
              key: `${row.match}-${index}`,
              style: {
                border: `1px solid ${PALETTE.border}`,
                borderRadius: 10,
                padding: '8px 10px 9px',
                marginBottom: 8,
                background: PALETTE.card,
              },
            },
            h(
              'div',
              { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 } },
              h('input', {
                value: row.match,
                onChange: (event) => update((next) => { next.rows[index].match = event.target.value; }),
                style: { ...field, flex: '1 1 auto', fontWeight: 600, textAlign: 'left' },
              }),
              h('button', {
                type: 'button',
                title: t('prices.remove'),
                onClick: () => update((next) => { next.rows.splice(index, 1); }),
                style: { border: 'none', background: 'transparent', color: PALETTE.sub, cursor: 'pointer', fontSize: 15, padding: '0 4px' },
              }, '×'),
            ),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: '44px 1fr 1fr 1fr', gap: 8, marginBottom: 3 } },
              h('span'),
              h('span', { style: { ...muted, textAlign: 'right' } }, t('prices.inputMiss')),
              h('span', { style: { ...muted, textAlign: 'right' } }, t('label.cacheRead')),
              h('span', { style: { ...muted, textAlign: 'right' } }, t('label.output')),
            ),
            ['peak', 'offPeak'].map((tier) => h(
              'div',
              { key: tier, style: { display: 'grid', gridTemplateColumns: '44px 1fr 1fr 1fr', gap: 8, alignItems: 'center', marginTop: 5 } },
              h(
                'span',
                {
                  style: {
                    fontSize: 11,
                    fontWeight: 600,
                    color: tier === 'offPeak' ? PALETTE.cyan : PALETTE.navy,
                  },
                },
                tier === 'offPeak' ? t('prices.offPeak') : t('prices.peak'),
              ),
              ['input', 'cacheRead', 'output'].map((key) => h('input', {
                key,
                value: row[tier]?.[key] ?? 0,
                inputMode: 'decimal',
                onChange: (event) => update((next) => { next.rows[index][tier][key] = event.target.value; }),
                style: { ...field, textAlign: 'right' },
              })),
            )),
          )),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              onClick: () => update((next) => {
                next.rows.push({
                  match: 'model-name',
                  note: '',
                  peak: { input: 2, cacheRead: 0.04, output: 8 },
                  offPeak: { input: 1, cacheRead: 0.02, output: 4 },
                });
              }),
              style: {
                border: `1px dashed ${PALETTE.border}`,
                background: 'transparent',
                color: PALETTE.sub,
                fontSize: 12,
                padding: '5px 10px',
                borderRadius: 6,
                cursor: 'pointer',
              },
            }, t('prices.add')),
            h('button', {
              type: 'button',
              onClick: savePrices,
              style: {
                border: 'none',
                background: PALETTE.cyan,
                color: '#fff',
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 14px',
                borderRadius: 6,
                cursor: 'pointer',
              },
            }, t('prices.save')),
            h('button', {
              type: 'button',
              onClick: async () => {
                try {
                  const next = await request('/reset-prices', { method: 'POST' });
                  setPrices(JSON.parse(JSON.stringify(next)));
                  setSaved(t('prices.saved'));
                  props.onRefresh();
                } catch (error) {
                  setSaved(String(error && error.message ? error.message : error));
                }
              },
              style: {
                border: `1px solid ${PALETTE.border}`,
                background: 'transparent',
                color: PALETTE.sub,
                fontSize: 12,
                padding: '5px 10px',
                borderRadius: 6,
                cursor: 'pointer',
              },
            }, t('prices.reset')),
          ),
          saved.length > 0
            ? h('div', { style: { fontSize: 11.5, color: PALETTE.cyan, marginTop: 8 } }, saved)
            : null,
        );
      }

      const footer = h(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            padding: '7px 14px 9px',
            borderTop: `1px solid ${PALETTE.border}`,
            fontSize: 10.5,
            color: PALETTE.sub,
            background: PALETTE.track,
          },
        },
        h(
          'span',
          null,
          scan?.scanning
            ? t('scan.running')
            : scan?.error
              ? t('scan.error', { message: scan.error })
              : t('scan.done', { files: scan?.files ?? 0, ms: scan?.durationMs ?? 0 }),
        ),
        h('button', {
          type: 'button',
          onClick: props.onRefresh,
          style: {
            border: 'none',
            background: 'transparent',
            color: PALETTE.cyan,
            fontSize: 11,
            cursor: 'pointer',
            padding: 0,
          },
        }, t('refresh')),
      );

      return h(
        'div',
        {
          role: 'dialog',
          'aria-label': t('title'),
          style: {
            position: 'fixed',
            right: 18,
            bottom: 152,
            width: 436,
            maxHeight: 'min(620px, calc(100vh - 190px))',
            display: 'flex',
            flexDirection: 'column',
            background: PALETTE.card,
            border: `1px solid ${PALETTE.border}`,
            borderRadius: 12,
            boxShadow: '0 18px 48px rgba(15, 31, 60, 0.22)',
            overflow: 'hidden',
            pointerEvents: 'auto',
          },
        },
        header,
        tabBar,
        h('div', { style: { overflowY: 'auto', flex: '1 1 auto' } }, body),
        footer,
      );
    }

    /**
     * The desk pet: a pill in the corner, and the panel it opens.
     * @param props - slot props (unused for this overlay entry).
     */
    const CostLedgerWidget = React.memo(function CostLedgerWidget(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const [open, setOpen] = React.useState(false);
      const [data, setData] = React.useState(null);

      const load = React.useCallback(async () => {
        try {
          const next = await request('/summary');
          setData(next);
        } catch (error) {
          setData((current) => (current === null ? { error: String(error && error.message ? error.message : error) } : current));
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        load();
        const timer = setInterval(() => {
          if (alive) load();
        }, open ? OPEN_POLL_MS : IDLE_POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [load, open]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [open]);

      const today = data?.ready ? data.today : null;
      const amount = today === null ? '--' : `¥${formatMoney(today.cost)}`;

      const pill = h(
        'button',
        {
          type: 'button',
          title: t('tip.open'),
          onClick: () => setOpen((value) => !value),
          style: {
            position: 'fixed',
            right: 18,
            bottom: 96,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px 6px 8px',
            borderRadius: 999,
            border: `1px solid ${PALETTE.border}`,
            background: PALETTE.card,
            boxShadow: '0 8px 22px rgba(15, 31, 60, 0.16)',
            cursor: 'pointer',
            pointerEvents: 'auto',
            color: PALETTE.navy,
            fontFamily: 'inherit',
          },
        },
        h(
          'span',
          {
            style: {
              width: 26,
              height: 26,
              borderRadius: '50%',
              background: PALETTE.cyanSoft,
              color: PALETTE.cyan,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none',
            },
          },
          h(CoinIcon, { size: 16 }),
        ),
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.15 } },
          h('span', { style: { fontSize: 10, color: PALETTE.sub, letterSpacing: '0.04em' } }, t('label.today')),
          h('span', {
            style: {
              fontSize: 14.5,
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              color: today === null ? PALETTE.sub : PALETTE.navy,
            },
          }, amount),
        ),
        h(
          'span',
          { style: { width: 52, height: 22, display: 'inline-block', flex: 'none' } },
          h(
            'svg',
            { viewBox: '0 0 52 22', width: 52, height: 22, 'aria-hidden': true },
            (() => {
              const days = (data?.series ?? []).slice(-7).map((day) => day.cost);
              if (days.length < 2) return null;
              const max = Math.max(0.01, ...days);
              const points = days.map((value, index) => {
                const x = (index / (days.length - 1)) * 52;
                const y = 20 - (value / max) * 16;
                return `${x.toFixed(1)},${y.toFixed(1)}`;
              }).join(' ');
              return h('polyline', {
                points,
                fill: 'none',
                stroke: PALETTE.cyan,
                strokeWidth: 1.6,
                strokeLinejoin: 'round',
                strokeLinecap: 'round',
              });
            })(),
          ),
        ),
      );

      return h(
        'div',
        { style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 900 } },
        pill,
        open
          ? h('div', {
            onClick: () => setOpen(false),
            style: { position: 'fixed', inset: 0, background: 'transparent', pointerEvents: 'auto' },
          })
          : null,
        open
          ? h(Panel, {
            data,
            t,
            onClose: () => setOpen(false),
            onRefresh: () => load(),
          })
          : null,
      );
    });

    /**
     * Client plugin body.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cost-ledger: dictionaries');
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'cost-ledger', order: 900, locale: NS },
        CostLedgerWidget,
      ));
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };
  },
});
