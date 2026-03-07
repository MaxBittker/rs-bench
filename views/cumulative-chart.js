// Standalone cumulative chart renderer for rs-bench
// Requires: Chart.js, shared-constants.js

(function() {
  // Icon caches
  const modelIconImages = {};
  const skillIconImages = {};

  function preloadIcons(onReady) {
    let remaining = 0;

    for (const [key, config] of Object.entries(MODEL_CONFIG)) {
      if (config.icon) {
        remaining++;
        const img = new Image();
        img.onload = img.onerror = () => { if (--remaining === 0 && onReady) onReady(); };
        img.src = config.icon;
        modelIconImages[key] = img;
      }
    }

    for (const skill of SKILL_ORDER) {
      remaining++;
      const img = new Image();
      img.onload = img.onerror = () => { if (--remaining === 0 && onReady) onReady(); };
      img.src = VIEWS_BASE + 'skill-icons/' + skill + '.png';
      skillIconImages[skill] = img;
    }

    if (remaining === 0 && onReady) onReady();
  }

  // Chart.js plugin: draw model icon + label at end of each line
  const endIconPlugin = {
    id: 'endIconCumulative',
    afterDraw(chart) {
      const ctx = chart.ctx;
      const size = 14;
      const labelGap = 3;
      const minSpacing = 12;

      const labels = [];
      for (const dataset of chart.data.datasets) {
        if (!dataset._modelKey) continue;
        const meta = chart.getDatasetMeta(chart.data.datasets.indexOf(dataset));
        if (!meta.visible) continue;
        const elements = meta.data;
        if (elements.length === 0) continue;
        const last = elements[elements.length - 1];
        if (!last) continue;

        const config = MODEL_CONFIG[dataset._modelKey] || { shortName: dataset._modelKey, color: '#999' };
        labels.push({
          x: last.x, y: last.y, drawY: last.y,
          modelKey: dataset._modelKey,
          name: config.shortName || config.displayName,
          color: config.color,
        });
      }

      labels.sort((a, b) => a.y - b.y);
      for (let i = 1; i < labels.length; i++) {
        const gap = labels[i].drawY - labels[i - 1].drawY;
        if (gap < minSpacing) labels[i].drawY = labels[i - 1].drawY + minSpacing;
      }

      for (const label of labels) {
        const icon = modelIconImages[label.modelKey];
        ctx.save();
        ctx.globalAlpha = 0.9;
        if (icon && icon.complete) {
          ctx.drawImage(icon, label.x - size / 2, label.y - size / 2, size, size);
        }
        ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillStyle = label.color;
        ctx.textBaseline = 'middle';
        ctx.fillText(label.name, label.x + size / 2 + labelGap, label.drawY);
        ctx.restore();
      }
    }
  };

  // Custom HTML tooltip
  let tooltipEl = null;
  function getTooltipEl() {
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'chart-tooltip';
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  function makeTooltipHandler(cumulativeSkillFinalXp, activeSkill) {
    return function(context) {
      const { chart, tooltip } = context;
      const el = getTooltipEl();

      if (tooltip.opacity === 0) { el.style.opacity = '0'; return; }

      const item = tooltip.dataPoints?.[0];
      if (!item) return;

      const ds = item.dataset;
      const modelKey = ds._modelKey;
      const config = MODEL_CONFIG[modelKey] || { displayName: modelKey, color: '#999' };
      const minute = Math.floor(item.parsed.x * 10) / 10;
      const xpValue = item.parsed.y;

      let html = `<div class="chart-tooltip-title">`;
      if (config.icon) html += `<img src="${config.icon}">`;
      html += `${config.displayName} — ${minute} min</div>`;

      if (activeSkill) {
        const skillName = SKILL_DISPLAY[activeSkill] || activeSkill;
        const iconSrc = VIEWS_BASE + 'skill-icons/' + activeSkill + '.png';
        html += `<div class="chart-tooltip-avg">${skillName}: ${xpValue.toLocaleString()} XP</div>`;
        html += `<div class="chart-tooltip-skill">`;
        html += `<img src="${iconSrc}">`;
        html += `<span>${skillName}</span>`;
        html += `<span class="xp">${formatXp(xpValue)}</span>`;
        html += `</div>`;
      } else {
        html += `<div class="chart-tooltip-avg">Total: ${xpValue.toLocaleString()} XP</div>`;

        const skills = cumulativeSkillFinalXp[modelKey] || [];
        for (const s of skills) {
          const iconSrc = VIEWS_BASE + 'skill-icons/' + s.skill + '.png';
          const zeroClass = s.finalXp === 0 ? ' zero' : '';
          html += `<div class="chart-tooltip-skill">`;
          html += `<img src="${iconSrc}">`;
          html += `<span>${s.label}</span>`;
          html += `<span class="xp${zeroClass}">${formatXp(s.finalXp)}</span>`;
          html += `</div>`;
        }
      }

      el.innerHTML = html;
      el.style.opacity = '1';

      const rect = chart.canvas.getBoundingClientRect();
      const caretX = rect.left + window.scrollX + tooltip.caretX;
      const caretY = rect.top + window.scrollY + tooltip.caretY;

      const tipWidth = el.offsetWidth || 240;
      if (caretX + tipWidth + 16 > window.innerWidth + window.scrollX) {
        el.style.left = (caretX - tipWidth - 12) + 'px';
      } else {
        el.style.left = (caretX + 12) + 'px';
      }
      el.style.top = (caretY - 20) + 'px';
    };
  }

  /**
   * Render a cumulative XP chart.
   * @param {Object} opts
   * @param {HTMLElement} opts.canvasContainer - element to hold the <canvas>
   * @param {HTMLElement} opts.legendContainer - element to hold the legend
   * @param {Object} opts.data - combined data (model -> skill -> {samples, finalXp, ...})
   * @param {number} opts.horizonMinutes - e.g. 30
   * @param {string|null} [opts.activeSkill] - selected skill key, or null for total XP
   */
  window.renderCumulativeChart = function({ canvasContainer, legendContainer, data, horizonMinutes, activeSkill = null, onClick }) {
    const cumulativeSkillFinalXp = {};
    const hiddenModels = new Set();
    let chart = null;

    function getModels() {
      return Object.keys(data)
        .sort((a, b) => ((MODEL_CONFIG[a] || {order:99}).order) - ((MODEL_CONFIG[b] || {order:99}).order));
    }

    function getModelTotalXp(model) {
      const skills = data[model];
      if (!skills) return 0;
      return Object.values(skills).map(s => s.finalXp || 0).reduce((a, b) => a + b, 0);
    }

    function getModelSkillXp(model, skill) {
      return data[model]?.[skill]?.finalXp || 0;
    }

    function getLegendXp(model) {
      return activeSkill ? getModelSkillXp(model, activeSkill) : getModelTotalXp(model);
    }

    function getModelsByPerformance() {
      return Object.keys(data).sort((a, b) => getLegendXp(b) - getLegendXp(a));
    }

    function renderLegend() {
      const models = getModelsByPerformance();
      legendContainer.innerHTML = models.map(name => {
        const config = MODEL_CONFIG[name] || { displayName: name, shortName: name, color: '#999' };
        const isHidden = hiddenModels.has(name);
        const totalXp = getLegendXp(name);
        const totalStr = totalXp > 0 ? formatXp(totalXp) : '-';
        return `<div class="legend-item ${isHidden ? 'hidden' : ''}" data-model="${name}">
          <div class="legend-dot" style="background:${config.color}"></div>
          <span class="legend-label">${config.shortName || config.displayName}</span>
          <span class="legend-value">${totalStr}</span>
        </div>`;
      }).join('');

      legendContainer.querySelectorAll('.legend-item').forEach(el => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => {
          const model = el.dataset.model;
          if (hiddenModels.has(model)) hiddenModels.delete(model);
          else hiddenModels.add(model);
          renderLegend();
          renderChart();
        });
      });
    }

    function renderChart() {
      if (chart) { chart.destroy(); chart = null; }
      canvasContainer.innerHTML = '';

      const canvas = document.createElement('canvas');
      canvasContainer.appendChild(canvas);

      const models = getModels().filter(m => !hiddenModels.has(m));
      const datasets = [];
      for (const model of models) {
        const config = MODEL_CONFIG[model] || { displayName: model, color: '#999' };
        let avgPoints = [];

        if (activeSkill) {
          avgPoints = extractSkillPoints(data[model]?.[activeSkill], activeSkill, horizonMinutes);
        } else {
          const BUCKET_COUNT = horizonMinutes + 1;
          const bucketSums = new Array(BUCKET_COUNT).fill(0);

          for (const skill of SKILL_ORDER) {
            const points = extractSkillPoints(data[model]?.[skill], skill, horizonMinutes);
            if (points.length === 0) continue;

            for (let min = 0; min < BUCKET_COUNT; min++) {
              let lastXp = 0;
              for (const p of points) {
                if (p.x <= min) lastXp = p.y;
                else break;
              }
              bucketSums[min] += lastXp;
            }
          }

          const skillFinals = [];
          for (const skill of SKILL_ORDER) {
            const sd = data[model]?.[skill];
            if (sd) skillFinals.push({ skill, label: SKILL_DISPLAY[skill] || skill, finalXp: sd.finalXp || 0 });
          }
          skillFinals.sort((a, b) => b.finalXp - a.finalXp);
          cumulativeSkillFinalXp[model] = skillFinals;

          for (let min = 0; min < BUCKET_COUNT; min++) {
            avgPoints.push({ x: min, y: Math.round(bucketSums[min]) });
          }
        }

        datasets.push({
          label: config.displayName,
          data: avgPoints,
          borderColor: config.color,
          backgroundColor: config.color,
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2.5,
          tension: 0.3,
          _modelKey: model,
        });
      }

      chart = new Chart(canvas, {
        type: 'line',
        data: { datasets },
        plugins: [endIconPlugin],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          layout: { padding: { top: 10, right: 96, bottom: 2 } },
          interaction: { mode: 'nearest', intersect: false },
          onClick: onClick ? function(event, elements) {
            if (elements.length > 0) {
              var ds = datasets[elements[0].datasetIndex];
              if (ds._modelKey) onClick(ds._modelKey);
            }
          } : undefined,
          scales: {
            x: {
              type: 'linear',
              min: 0,
              max: horizonMinutes,
              ticks: { color: '#999', font: { size: 11 }, stepSize: horizonMinutes <= 10 ? 2 : 5, callback: v => v + ' min' },
              grid: { color: '#f0f0f0', drawTicks: false },
              border: { color: '#e0e0e0' },
              title: { display: true, text: 'Elapsed Time', color: '#999', font: { size: 12 } },
            },
            y: {
              min: 0,
              ticks: {
                color: '#999',
                font: { size: 11, family: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace' },
                maxTicksLimit: 8,
                callback: v => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v,
              },
              grid: { color: '#f0f0f0', drawTicks: false },
              border: { color: '#e0e0e0' },
              title: { display: false },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: false,
              external: makeTooltipHandler(cumulativeSkillFinalXp, activeSkill),
            },
          },
        },
      });
    }

    preloadIcons(() => { if (chart) chart.draw(); });
    renderLegend();
    renderChart();
  };
})();
