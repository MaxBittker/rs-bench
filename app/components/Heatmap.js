import { html, useMemo } from '../html.js';
import { navigate } from '../router.js';

const HORIZON_MS = 30 * 60 * 1000;

const TIERS = {
  zero: { bg: '#e8e8e8', color: '#aaa' },
  low:  { bg: '#c8e6c9', color: '#2e5e3e' },
  mid:  { bg: '#81c784', color: '#1a3d1f' },
  high: { bg: '#43a047', color: '#fff' },
};

function levelAtHorizon(skillData, skill) {
  if (!skillData) return 1;
  const samples = skillData.samples;
  if (!samples || samples.length === 0) return skillData.finalLevel || 1;
  const skillName = SKILL_DISPLAY[skill];
  let lastLevel = 1;
  for (const s of samples) {
    if (s.elapsedMs > HORIZON_MS) break;
    if (s.skills) {
      for (const [name, d] of Object.entries(s.skills)) {
        if (name.toLowerCase() === skillName.toLowerCase() || name.toLowerCase() === skill) {
          lastLevel = d.level || 1;
        }
      }
    }
  }
  return lastLevel;
}

export function Heatmap({ data }) {
  const { models, skillOrder, tiers } = useMemo(() => {
    if (!data) return { models: [], skillOrder: [], tiers: {} };

    const models = Object.keys(data).map(key => {
      const skills = {};
      let totalLevel = 0;
      for (const skill of SKILL_ORDER) {
        const level = levelAtHorizon(data[key]?.[skill], skill);
        skills[skill] = level;
        totalLevel += level;
      }
      return { key, totalLevel, skills };
    });

    models.sort((a, b) => b.totalLevel - a.totalLevel);

    const skillOrder = SKILL_ORDER.slice().sort((a, b) => {
      const avgA = models.reduce((s, m) => s + m.skills[a], 0) / models.length;
      const avgB = models.reduce((s, m) => s + m.skills[b], 0) / models.length;
      return avgB - avgA;
    });

    const tiers = {};
    for (const skill of skillOrder) {
      tiers[skill] = {};
      const trained = models
        .filter(m => m.skills[skill] > 1)
        .map(m => m.skills[skill])
        .sort((a, b) => a - b);

      if (trained.length === 0) {
        models.forEach(m => { tiers[skill][m.key] = 'zero'; });
        continue;
      }

      const thirdLen = Math.max(1, Math.ceil(trained.length / 3));
      const lowMax = trained[thirdLen - 1];
      const midMax = trained[Math.min(thirdLen * 2 - 1, trained.length - 1)];

      for (const m of models) {
        const lvl = m.skills[skill];
        if (lvl <= 1) tiers[skill][m.key] = 'zero';
        else if (lvl <= lowMax && trained.length > 1) tiers[skill][m.key] = 'low';
        else if (lvl <= midMax && trained.length > 2) tiers[skill][m.key] = 'mid';
        else tiers[skill][m.key] = 'high';
      }
    }

    return { models, skillOrder, tiers };
  }, [data]);

  if (!data || models.length === 0) return null;

  function handleCellClick(modelKey, skill) {
    const sd = data[modelKey]?.[skill];
    if (sd?.trajectory?.length > 0) {
      navigate('trajectory/' + modelKey + '/' + skill);
    } else {
      navigate('model/' + modelKey);
    }
  }

  return html`
    <section className="section">
      <div className="container is-max-widescreen">
        <div className="columns is-centered has-text-centered">
          <div className="column">
            <h2 className="title is-3">Per-Skill Breakdown</h2>
            <p className="subtitle is-6" style=${{ color: '#888' }}>
              Skill level reached per model. Best of 1. Color intensity indicates relative ranking within each skill column.
            </p>
          </div>
        </div>
        <div className="heatmap-scroll">
          <table className="heatmap-table">
            <thead>
              <tr>
                <th style=${{ textAlign: 'left' }}>Model</th>
                ${skillOrder.map(skill => html`
                  <th key=${skill} title=${SKILL_DISPLAY[skill]}>
                    <img src=${VIEWS_BASE + 'skill-icons/' + skill + '.png'}
                         alt=${SKILL_DISPLAY[skill]} width="16" height="16" />
                  </th>
                `)}
                <th style=${{ fontWeight: 700 }}>Total</th>
              </tr>
            </thead>
            <tbody>
              ${models.map(m => {
                const cfg = MODEL_CONFIG[m.key];
                if (!cfg) return null;
                return html`
                  <tr key=${m.key}>
                    <td className="heatmap-model"
                        onClick=${() => navigate('model/' + m.key)}
                        style=${{ cursor: 'pointer' }}>
                      <img src=${cfg.icon} alt="" />
                      <span>${cfg.shortName}</span>
                    </td>
                    ${skillOrder.map(skill => {
                      const tier = tiers[skill][m.key];
                      const s = TIERS[tier];
                      return html`
                        <td key=${skill}
                            style=${{ background: s.bg, color: s.color, fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }}
                            onClick=${() => handleCellClick(m.key, skill)}>
                          ${m.skills[skill] > 1 ? String(m.skills[skill]) : '1'}
                        </td>
                      `;
                    })}
                    <td className="heatmap-total">${String(m.totalLevel)}</td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}
