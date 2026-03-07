import { html } from '../html.js';

export function BenchmarkDesign() {
  return html`
    <section className="section">
      <div className="container is-max-desktop">
        <div className="columns is-centered has-text-centered">
          <div className="column">
            <h2 className="title is-3">Benchmark Design</h2>
          </div>
        </div>
        <div className="features-grid" style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div className="feature-box">
            <h4 className="title is-5">16 Skills</h4>
            <p>Each RuneScape skill is a separate task, measuring XP gained within 10-minute and 30-minute wall-clock horizons (equivalent to 80 min and 4 hrs in-game at 8x speed).</p>
          </div>
          <div className="feature-box">
            <h4 className="title is-5">Sandboxed Environment</h4>
            <p>Each run uses a fresh Docker container with the game server running at 8x speed (wall-clock horizons of 10\u201330 min correspond to 80 min\u20134 hrs of in-game time).</p>
          </div>
          <div className="feature-box">
            <h4 className="title is-5">Multi-Model Comparison</h4>
            <p>Run the same tasks across multiple frontier models to compare agent capabilities.</p>
          </div>
        </div>
      </div>
    </section>
  `;
}
