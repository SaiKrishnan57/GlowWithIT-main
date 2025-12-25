// execute the following code when the DOM components are loaded
window.addEventListener('DOMContentLoaded', () => {

  (async () => {
    if (!window.echarts) {
      await new Promise(resolve => {
        const tick = () => (window.echarts ? resolve() : setTimeout(tick, 30));
        tick();
      });
    }

    const crimeHeatMap = document.getElementById('crimeHeatmapEC');
    if (!crimeHeatMap) {
      console.error('Heatmap component can not be found.');
      return;
    }

    // ---------- THEME TOKENS (dim + accessible) ----------
    const isBright =
      document.documentElement.classList.contains('gw-bright') ||
      document.body.classList.contains('gw-bright') ||
      document.documentElement.dataset.theme === 'bright';

    // Lower-chroma ramps; end at midtones to avoid neon glare
    const T = isBright
      ? {
          text: '#374151',
          axis: '#6b7280',
          vmText: '#6b7280',
          cellLabel: '#111827',
          gridBorder: '#e5e7eb',
          male:   ['#eef2ff','#dbeafe','#bfdbfe','#93c5fd','#60a5fa','#3b82f6'],
          female: ['#fee2e2','#fecaca','#fca5a5','#f87171','#ef4444','#b91c1c'],
          overlayBg: 'rgba(255,255,255,.75)',
          overlayText: '#374151'
        }
      : {
          text: '#e5e7eb',
          axis: '#94a3b8',
          vmText: '#cbd5e1',
          cellLabel: '#f8fafc',
          gridBorder: 'rgba(255,255,255,.08)',
          male:   ['#0b1e3a','#123a61','#1e4f82','#2a6aa6','#3b82f6','#6ea8ff'],
          female: ['#421717','#5a1c1c','#7a2424','#a83232','#d14a4a','#f08a8a'],
          overlayBg: 'rgba(2,6,23,.55)',
          overlayText: '#e5e7eb'
        };

    // ---------- data ----------
    const url = "/api/heatmap/crime/";
    const res = await fetch(url, { headers: { "Accept": "application/json" }, credentials: "same-origin" });
    const text = await res.text();
    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    if (!isJson) { console.error("Expected JSON from", url, "but got:", res.status, text.slice(0, 300)); return; }

    let json_response;
    try { json_response = JSON.parse(text); }
    catch (e) { console.error("JSON parse failed:", e, text.slice(0, 300)); return; }

    const { regions, sexes, cells, totals, title } = json_response;

    const pct  = (p, w) => w ? Math.round(p / w * 100) : 0;
    const byId = id => document.getElementById(id);
    byId('ev-total') ?.appendChild(document.createTextNode(totals.all.toLocaleString()));
    byId('ev-male')  ?.appendChild(document.createTextNode(`${totals.male.toLocaleString()} (${pct(totals.male, totals.all)}%)`));
    byId('ev-female')?.appendChild(document.createTextNode(`${totals.female.toLocaleString()} (${pct(totals.female, totals.all)}%)`));

    const xIndex = Object.fromEntries(sexes.map((s, i) => [s, i]));
    const yIndex = Object.fromEntries(regions.map((r, i) => [r, i]));

    const norm = s => String(s).trim().toLowerCase();
    const isMale   = s => /^(m|male|males|man|men)$/.test(norm(s));
    const isFemale = s => /^(f|female|females|woman|women)$/.test(norm(s));

    const maleKey   = sexes.find(isMale)   ?? sexes[0];
    const femaleKey = sexes.find(isFemale) ?? sexes[1];

    const maleXi   = xIndex[maleKey];
    const femaleXi = xIndex[femaleKey];

    const maleData   = cells.filter(c => xIndex[c.x] === maleXi  ).map(c => [maleXi,   yIndex[c.y], c.v]);
    const femaleData = cells.filter(c => xIndex[c.x] === femaleXi).map(c => [femaleXi, yIndex[c.y], c.v]);

    const vmaxMale   = Math.max(1, ...maleData.map(d => d[2]));
    const vmaxFemale = Math.max(1, ...femaleData.map(d => d[2]));

    const chart = echarts.init(crimeHeatMap, null, { renderer: 'canvas' });

    // Label threshold: show numbers only on stronger cells (reduces glare/clutter)
    const maleThresh   = Math.round(vmaxMale   * 0.28);
    const femaleThresh = Math.round(vmaxFemale * 0.28);

    // More top headroom so the title never overlaps the icons
    const gridTop = window.innerWidth < 576 ? 110 : 140;

    chart.setOption({
      backgroundColor: 'transparent',
      title: {
        text: title,
        left: 'center',
        top: 10,
        textStyle: { color: T.text, fontSize: window.innerWidth < 576 ? 12 : 16, fontWeight: '700' }
      },
      tooltip: {
        position: 'top',
        borderColor: isBright ? '#e5e7eb' : 'rgba(148,163,184,.25)',
        backgroundColor: isBright ? '#ffffff' : 'rgba(17,24,39,.95)',
        textStyle: { color: T.text },
        formatter: ({ value }) => {
          const [xi, yi, v] = value;
          return `${regions[yi]}<br/>${sexes[xi]}: <b>${v.toLocaleString()}</b> incidents`;
        }
      },
      grid: { top: gridTop, left: 120, right: 24, bottom: 88, containLabel: false },
      xAxis: {
        type: 'category',
        data: sexes,
        position: 'top',
        axisLabel: { formatter: () => '', color: T.axis, fontWeight: '600' },
        axisTick: { show: false },
        splitLine: { show: true, lineStyle: { color: T.gridBorder } },
        splitArea: { show: false }
      },
      yAxis: {
        type: 'category',
        data: regions,
        axisLabel: { color: T.axis, fontWeight: '700' },
        axisTick: { show: false },
        splitLine: { show: true, lineStyle: { color: T.gridBorder } },
        splitArea: { show: false }
      },
      visualMap: [
        {
          min: 0, max: vmaxMale, seriesIndex: 0, orient: 'horizontal', left: 'center', bottom: 34,
          text: ['High (M)', 'Low (M)'], textStyle: { color: T.vmText },
          inRange: { color: T.male }
        },
        {
          min: 0, max: vmaxFemale, seriesIndex: 1, orient: 'horizontal', left: 'center', bottom: 10,
          text: ['High (F)', 'Low (F)'], textStyle: { color: T.vmText },
          inRange: { color: T.female }
        }
      ],
      series: [
        {
          type: 'heatmap', name: maleKey, data: maleData,
          label: {
            show: true,
            color: T.cellLabel,
            fontWeight: 700,
            fontSize: 11,
            formatter: p => (p.value[2] >= maleThresh ? p.value[2] : '')
          },
          emphasis: { itemStyle: { borderColor: isBright ? '#3b82f6' : 'rgba(59,130,246,.8)', borderWidth: 1 } }
        },
        {
          type: 'heatmap', name: femaleKey, data: femaleData,
          label: {
            show: true,
            color: T.cellLabel,
            fontWeight: 700,
            fontSize: 11,
            formatter: p => (p.value[2] >= femaleThresh ? p.value[2] : '')
          },
          emphasis: { itemStyle: { borderColor: isBright ? '#ef4444' : 'rgba(239,68,68,.85)', borderWidth: 1 } }
        }
      ]
    });

    // ---------- icons above the grid ----------
    const femaleIconUrl = crimeHeatMap.dataset.femaleIcon || '/static/images/female-crime.png';
    const maleIconUrl   = crimeHeatMap.dataset.maleIcon   || '/static/images/male-crime.png';

    const zr = chart.getZr();
    let femaleGroup = null, maleGroup = null;

    function makeSexGroup(imageUrl, labelText) {
      const g = new echarts.graphic.Group({ silent: true, z: 100 });

      const img = new echarts.graphic.Image({
        style: { image: imageUrl, width: 60, height: 60, x: -30, y: 0 }
      });

      const txt = new echarts.graphic.Text({
        style: {
          text: labelText,
          x: -40,
          y: 30,
          textAlign: 'right',
          textBaseline: 'middle',
          fill: T.overlayText,
          font: '600 14px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial',
          backgroundColor: T.overlayBg,
          padding: [2,6],
          borderRadius: 6
        }
      });

      g.add(txt);
      g.add(img);
      g.__img = img;
      g.__txt = txt;
      return g;
    }

    function layoutSexGroups() {
      const model  = chart.getModel?.();
      const gridCS = model?.getComponent('grid')?.coordinateSystem;
      const rect   = gridCS?.getRect?.();
      if (!rect) return;

      const xAxisModel = model?.getComponent('xAxis', 0);
      const fs = (xAxisModel?.option?.axisLabel?.fontSize) || 12;
      const labelH = Math.round(fs * 1.6);

      const xf = chart.convertToPixel({ gridIndex: 0 }, [femaleXi, 0])[0];
      const xm = chart.convertToPixel({ gridIndex: 0 }, [maleXi,   0])[0];

      const size = Math.max(56, Math.min(96, Math.round(rect.width / 8)));
      const yTop = Math.max(6, rect.y - labelH - size - 6);

      if (!femaleGroup) { femaleGroup = makeSexGroup(femaleIconUrl, femaleKey); zr.add(femaleGroup); }
      if (!maleGroup)   { maleGroup   = makeSexGroup(maleIconUrl,   maleKey);   zr.add(maleGroup);   }

      const pad = 10;
      const iconTextGap = 24;

      femaleGroup.__img.attr({ style: { width: size, height: size, x: -size/2, y: 0 } });
      maleGroup.__img.attr({   style: { width: size, height: size, x: -size/2, y: 0 } });

      femaleGroup.__txt.attr({ style: { x: -size/2 - pad - iconTextGap, y: size/2, fill: T.overlayText, backgroundColor: T.overlayBg } });
      maleGroup.__txt.attr({   style: { x: -size/2 - pad - iconTextGap, y: size/2, fill: T.overlayText, backgroundColor: T.overlayBg } });

      femaleGroup.attr('position', [xf, yTop]);
      maleGroup.attr('position',   [xm, yTop]);

      zr.refreshImmediately();
    }

    chart.off('finished');
    chart.on('finished', layoutSexGroups);
    layoutSexGroups();

    // Resize without flicker
    let rafId = null;
    window.addEventListener('resize', () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        chart.resize();
        layoutSexGroups();
      });
    });

  })();
});
