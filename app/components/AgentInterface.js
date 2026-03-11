import { html, useEffect, useRef } from '../html.js';
import { WikiBrowser } from './WikiBrowser.js';

const EXAMPLE_CODE = `// Chop trees, dropping logs when inventory fills
while (true) {
  if (sdk.getInventory().length >= 27) {
    for (const item of sdk.getInventory())
      if (/log/i.test(item.name)) await sdk.sendDropItem(item.slot);
  }
  await bot.chopTree(/^tree$/i);
}`;

function CodeBlock({ code, lang }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && window.hljs) {
      ref.current.removeAttribute('data-highlighted');
      window.hljs.highlightElement(ref.current);
    }
  }, [code]);
  return html`<pre className="agent-code-pre"><code ref=${ref} className=${'language-' + lang}>${code}</code></pre>`;
}

export function AgentInterface() {
  return html`
    <section className="section">
      <div className="container is-max-desktop">
        <div className="columns is-centered has-text-centered">
          <div className="column is-four-fifths">
            <h2 className="title is-3">How Agents See the World</h2>
            <div className="content has-text-justified">
              <p>
                Off-the-shelf coding agents like Claude Code, Codex, and Gemini CLI play the game via TypeScript snippets executed against an emulated game server. They have access to a game knowledge folder and a full-featured TypeScript SDK.
              </p>
            </div>
          </div>
        </div>
        <div className="columns" style=${{ marginTop: '2rem', gap: '1.5rem' }}>
          <div className="column">
            <div className="agent-panel-label">TypeScript SDK</div>
            <${CodeBlock} code=${EXAMPLE_CODE} lang="javascript" />
          </div>
          <div className="column">
            <div className="agent-panel-label">Game Knowledge</div>
            <${WikiBrowser} />
          </div>
        </div>
      </div>
    </section>
  `;
}
