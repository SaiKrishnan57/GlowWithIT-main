/**
 * awareness.js — theme-aware (dark/bright), dimmed colors
 * - Shared color palette + soft rgba fills
 * - Helpers for Bar / Doughnut (Chart.js v4)
 * - Works with your cascading dropdown flow in insights.html
 */
(() => {

  // ---------- Theme tokens (low-chroma across modes) ----------
  function isBrightMode() {
    const d = document.documentElement, b = document.body;
    return (
      d.classList.contains('gw-bright') ||
      b.classList.contains('gw-bright') ||
      d.dataset.theme === 'bright' ||
      d.dataset.theme === 'light'
    );
  }

  function hexToRgb(hex) {
    const h = hex.replace('#','');
    const bigint = parseInt(h.length === 3 ? h.split('').map(x=>x+x).join('') : h, 16);
    return { r:(bigint>>16)&255, g:(bigint>>8)&255, b:bigint&255 };
  }
  function rgba(hex, a=0.85){ const {r,g,b}=hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }

  const THEME = (() => {
    const bright = isBrightMode();
    return bright ? {
      text:      '#374151',
      subtext:   '#6b7280',
      grid:      '#e5e7eb',
      legend:    '#4c1d95',   // dark purple in bright mode
      tooltipBg: '#ffffff',
      tooltipBorder: '#e5e7eb',
      tooltipTitle:  '#111827',
      tooltipBody:   '#374151',
      alpha: 0.82
    } : {
      text:      '#e5e7eb',
      subtext:   '#cbd5e1',
      grid:      'rgba(148,163,184,.25)',
      legend:    '#e5e7eb',
      tooltipBg: 'rgba(17,24,39,.96)',
      tooltipBorder: 'rgba(148,163,184,.25)',
      tooltipTitle:  '#f8fafc',
      tooltipBody:   '#e5e7eb',
      alpha: 0.88
    };
  })();

  // NEW: compute legend ink at runtime (so it updates on theme flips)
  function legendInk(){ return isBrightMode() ? '#4c1d95' : '#e5e7eb'; }

  // ---------- Base hues (we’ll soften with rgba alpha) ----------
  const BASE = {
    rose:    '#e11d48',
    blue:    '#3b82f6',
    emerald: '#10b981',
    amber:   '#f59e0b',
    gray:    '#64748b'
  };
  // Final colors actually used by datasets (muted via alpha)
  const COLORS = {
    rose:    rgba(BASE.rose,    THEME.alpha),
    blue:    rgba(BASE.blue,    THEME.alpha),
    emerald: rgba(BASE.emerald, THEME.alpha),
    amber:   rgba(BASE.amber,   THEME.alpha),
    gray:    rgba(BASE.gray,    THEME.alpha)
  };

  // ---------- Chart.js defaults (safe, readable) ----------
  if (typeof Chart !== 'undefined') {
    Chart.defaults.color = THEME.text;
    Chart.defaults.font.family =
      'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"';
    Chart.defaults.plugins.tooltip.backgroundColor = THEME.tooltipBg;
    Chart.defaults.plugins.tooltip.titleColor      = THEME.tooltipTitle;
    Chart.defaults.plugins.tooltip.bodyColor       = THEME.tooltipBody;
    Chart.defaults.plugins.tooltip.borderColor     = THEME.tooltipBorder;
    Chart.defaults.plugins.tooltip.borderWidth     = 1;

    // ensure default legend label color uses the runtime ink
    Chart.defaults.plugins.legend = Chart.defaults.plugins.legend || {};
    Chart.defaults.plugins.legend.labels = Chart.defaults.plugins.legend.labels || {};
    Chart.defaults.plugins.legend.labels.color = legendInk();
  }

  // Define all required events Chart.js should listen to
  const CHART_EVENTS = ["mousemove", "mouseout", "click", "touchstart", "touchmove"];

  // Default interaction
  const CHART_INTERACTION = { mode: "nearest", intersect: true, axis: "xy" };

  // Tooltip label formatter
  const tooltipLabel = (tt) => {
    const parsed = (tt.parsed && (tt.parsed.y ?? tt.parsed)) ?? tt.raw;
    const isPct  = typeof parsed === "number" && parsed >= 0 && parsed <= 100;
    const title  = tt.dataset?.label || tt.label || "";
    const value  = `${parsed}${isPct ? "%" : ""}`;
    return title ? `${title}: ${value}` : value;
  };

  // Emoji above bars
  const EmojiLabelPlugin = {
    id: "emojiLabel",
    afterDatasetsDraw(chart, _args, opts) {
      const emojis = opts?.emojis;
      if (!emojis || !chart.getDatasetMeta?.(0)) return;
      const meta = chart.getDatasetMeta(0);
      const { ctx } = chart;
      const yOffset = opts?.yOffset ?? 8;
      const fontSize = opts?.fontSize ?? 18;

      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.font = `${fontSize}px system-ui, Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji`;
      meta.data.forEach((el, i) => {
        const emoji = typeof emojis === "function" ? emojis(i, chart) : emojis[i];
        if (!emoji) return;
        const x = el.x;
        const topY = Math.min(el.y, el.base) - yOffset;
        ctx.fillText(emoji, x, topY);
      });
      ctx.restore();
    }
  };
  if (typeof Chart !== "undefined") Chart.register(EmojiLabelPlugin);

  // Canvas getter (or create-one)
  function getCanvas(elementOrId) {
    let container = typeof elementOrId === "string" ? document.getElementById(elementOrId) : elementOrId;
    if (!container) return null;
    if (container.tagName?.toLowerCase() === "canvas") return container;
    let canvas = container.querySelector("canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      container.appendChild(canvas);
    }
    return canvas;
  }

  // ---------- Bar ----------
  function createBarChart(elementOrId, labels, values, colors, options = {}) {
    const canvas = getCanvas(elementOrId);
    if (!canvas) return null;
    const background = Array.isArray(colors) ? colors : values.map(() => colors);

    const chart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Value",
          data: values,
          backgroundColor: background,
          borderColor: background,     // keep edge subtle
          borderWidth: 0,
          borderRadius: 8,
          maxBarThickness: 48
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        events: CHART_EVENTS,
        interaction: CHART_INTERACTION,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true, callbacks: { label: tooltipLabel } },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: THEME.subtext, font: { weight: 600 } }
          },
          y: {
            beginAtZero: true,
            suggestedMax: Math.max(...values) <= 100 ? 100 : undefined,
            ticks: { callback: (v) => `${v}`, color: THEME.subtext },
            grid: { color: THEME.grid }
          },
        },
        ...options,
      },
    });

    new ResizeObserver(() => chart?.resize?.()).observe(canvas.parentElement);
    return chart;
  }

  // ---------- Doughnut ----------
  function createDonutChart(elOrId, labels, values, colors) {
    const canvas = getCanvas(elOrId);
    if (!canvas) return null;
    const background = Array.isArray(colors) ? colors : values.map(() => colors);

    const chart = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          label: "Share",
          data: values,
          backgroundColor: background,
          borderColor: THEME.grid,     // faint ring border for definition
          borderWidth: 1,
          hoverOffset: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        events: CHART_EVENTS,
        interaction: CHART_INTERACTION,
        plugins: {
          legend: {
            display: true,
            position: "right",
            labels: { boxWidth: 18, padding: 14, color: legendInk(), usePointStyle: true, pointStyle: 'circle' } // ← use runtime color
          },
          tooltip: { enabled: true, callbacks: { label: tooltipLabel } },
        },
        cutout: "64%",
      },
    });

    new ResizeObserver(() => chart?.resize?.()).observe(canvas.parentElement);
    return chart;
  }

  // ---------- Chart initializers (use softened COLORS) ----------
  function initChartAvoidNight(el){ return createDonutChart(el, ["Women","Men"], [63,31], [COLORS.rose, COLORS.blue]); }
  function initChartSexHarass(el){  return createDonutChart(el, ["Women","Men"], [13,4.5], [COLORS.rose, COLORS.blue]); }
  function initChartStalking(el){   return createDonutChart(el, ["Women","Men"], [20,6.7], [COLORS.rose, COLORS.blue]); }
  function initChartIPV(el){        return createDonutChart(el, ["Women","Men"], [23,7.3], [COLORS.rose, COLORS.blue]); }
  function initChartVicNightSafe(el){ return createDonutChart(el, ["Women","Men"], [44,78.8], [COLORS.rose, COLORS.blue]); }
  function initChartPTAfterDark(el){  return createBarChart(el, ["Women","Men"], [77.4,92.6], [COLORS.rose, COLORS.blue]); }
  function initChartNightNetwork(el){ return createDonutChart(el, ["24-hour nights","Other nights"], [2,5], [COLORS.emerald, COLORS.gray]); }
  function initChartNightNetworkPT(el){ return createDonutChart(el, ["24-hour nights (Fri, Sat)","Other nights"], [2,5], [COLORS.emerald, COLORS.gray]); }
  function initChartSTOPIT(el){ setBlockAccent(el, 'amber');return createBarChart(el, ["Reports","Investigations","Charges"], [3000,60,33], [COLORS.amber, COLORS.blue, COLORS.emerald]); }
  function initChartSTOPITTransport(el){ return createDonutChart(el, ["Trams","Buses","Trains"], [541,423,1990], [COLORS.amber, COLORS.blue, COLORS.emerald]); }
  function initChartHomeUnSafeWomen(el){ return createBarChart(el, ["2016","2021–2022"], [42,37], [COLORS.emerald, COLORS.gray]); }
  function initChartHomeSafeWomen(el){ return createDonutChart(el, ["Feel safe","Not sure/unsafe"], [93,7], [COLORS.emerald, COLORS.gray]); }
  function initChartCctvLighting(el){ return createBarChart(el, ["CCTV ($m)","Lighting ($m)"], [2.1,1.0], [COLORS.emerald, COLORS.blue]); }
  function initChartBudget(el){ return createBarChart(el, ["2024–25 ($m)","2025–26 ($m)"], [9.5,14], [COLORS.gray, COLORS.emerald]); }

  // Public map
  const INIT = Object.create(null);
  INIT.chartAvoidNight       = initChartAvoidNight;
  INIT.chartSexHarass        = initChartSexHarass;
  INIT.chartStalking         = initChartStalking;
  INIT.chartIPV              = initChartIPV;
  INIT.chartVicNightSafe     = initChartVicNightSafe;
  INIT.chartPTAfterDark      = initChartPTAfterDark;
  INIT.chartNightNetwork     = initChartNightNetwork;
  INIT.chartNightNetworkPT   = initChartNightNetworkPT;
  INIT.chartSTOPIT           = initChartSTOPIT;
  INIT.chartSTOPITTransport  = initChartSTOPITTransport;
  INIT.chartHomeUnSafeWomen  = initChartHomeUnSafeWomen;
  INIT.chartHomeSafeWomen    = initChartHomeSafeWomen;
  INIT.chartCctvLighting     = initChartCctvLighting;
  INIT.chartBudget           = initChartBudget;

  // Cache of live Chart instances
  const chartInstances = new Map();

  // Initialize a chart inside a .viz-block
  function initializeChartInBlock(vizBlock) {
    const chartContainer = vizBlock.querySelector(".chart-frame");
    if (!chartContainer) return;

    let id = chartContainer.id || chartContainer.dataset.chartId;
    if (!id) {
      const innerCanvas = chartContainer.querySelector("canvas[id]");
      id = innerCanvas?.id || `chart-${Math.random().toString(36).slice(2, 9)}`;
      chartContainer.id = id;
    }

    if (!chartInstances.has(id) && INIT[id]) {
      const instance = INIT[id](chartContainer);
      if (instance) {
        chartInstances.set(id, instance);
        setTimeout(() => instance?.resize?.(), 100);
      }
      return;
    }

    const existing = chartInstances.get(id);
    existing?.resize?.();
  }

  // set the block’s accent so both outlines match
  function setBlockAccent(elOrId, keyOrHex){
    const raw = BASE[keyOrHex] || keyOrHex; // use BASE['amber'|'rose'|'emerald'] or a hex string
    const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
    const block = el?.closest('.viz-block');
    if (block) block.style.setProperty('--accent', raw);
  }

  // Legacy one-dropdown filter (kept for compatibility)
  function applyFilter(value) {
    const blocks = Array.from(document.querySelectorAll(".viz-block"));
    const wraps  = Array.from(document.querySelectorAll(".section-wrap"));

    blocks.forEach(b => b.classList.add("is-hidden"));

    if (value === "all" || !value) {
      blocks.forEach(block => {
        block.classList.remove("is-hidden");
        initializeChartInBlock(block);
      });
    } else {
      const firstMatch = blocks.find(b => b.dataset.source === value);
      if (firstMatch) {
        firstMatch.classList.remove("is-hidden");
        initializeChartInBlock(firstMatch);
      }
    }

    wraps.forEach(wrap => {
      const visibleChild = wrap.querySelector(".viz-block:not(.is-hidden)");
      wrap.classList.toggle("is-collapsed", !visibleChild);
    });

    setTimeout(() => chartInstances.forEach(c => c?.resize?.()), 80);
  }

  function bootstrapAwareness(){
    const root = document.getElementById("awareness");
    if (!root) return;

    const cascading = !!document.getElementById("vizFilter");

    // Hook for insights.html (lazy import flow)
    window.initAwarenessCharts = function(){
      root.querySelectorAll(".viz-block.is-active").forEach(initializeChartInBlock);
      setTimeout(() => chartInstances.forEach(c => c?.resize?.()), 60);
    };

    // Recolor on theme flips (if you toggle .gw-bright dynamically)
    const ro = new MutationObserver(() => {
      // update legend label ink to match current theme, then redraw
      chartInstances.forEach(c => {
        if (c?.options?.plugins?.legend?.labels) {
          c.options.plugins.legend.labels.color = legendInk();
        }
        c?.update?.();
      });
    });
    ro.observe(document.documentElement, { attributes: true, attributeFilter: ['class','data-theme'] });

    if (cascading) {
      window.addEventListener("resize", () => chartInstances.forEach(c => c?.resize?.()));
      window.initAwarenessCharts();
      return;
    }

    // Legacy single dropdown
    const select = document.getElementById("sourceFilter");
    const initial = select ? select.value : "all";
    applyFilter(initial);
    if (select) select.addEventListener("change", (e) => applyFilter(e.target.value));
    document.querySelectorAll(".viz-block:not(.is-hidden)").forEach(initializeChartInBlock);
    window.addEventListener("resize", () => chartInstances.forEach(c => c?.resize?.()));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrapAwareness);
  } else {
    bootstrapAwareness();
  }

})();
