import { html, useState } from '../html.js';
import { WIKI_TREE } from '../wiki-data.js';

function slugToTitle(slug) {
  return slug.replace(/\.md$/, '').replace(/-/g, ' ');
}

function MarkdownContent({ text }) {
  const lines = text.split('\n');
  const parts = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('# ')) {
      parts.push(html`<div key=${i} style=${{ fontWeight: 600, fontSize: 13, marginBottom: 4, marginTop: i > 0 ? 8 : 0 }}>${line.slice(2)}</div>`);
    } else if (line.startsWith('## ')) {
      parts.push(html`<div key=${i} style=${{ fontWeight: 600, fontSize: 12, color: '#555', marginBottom: 2, marginTop: 8 }}>${line.slice(3)}</div>`);
    } else if (line.startsWith('### ')) {
      parts.push(html`<div key=${i} style=${{ fontWeight: 600, fontSize: 11, color: '#666', marginBottom: 2, marginTop: 6 }}>${line.slice(4)}</div>`);
    } else if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = lines[i].split('|').slice(1, -1).map(c => c.trim());
        if (!cells.every(c => /^[-:]+$/.test(c))) {
          rows.push(cells);
        }
        i++;
      }
      parts.push(html`<table key=${'t' + i} className="wiki-md-table">
        ${rows.map((row, ri) => html`<tr key=${ri}>
          ${row.map((cell, ci) => ri === 0
            ? html`<th key=${ci}>${cell}</th>`
            : html`<td key=${ci}>${cell}</td>`
          )}
        </tr>`)}
      </table>`);
      continue;
    } else if (line.startsWith('- ')) {
      parts.push(html`<div key=${i} style=${{ fontSize: 11, color: '#666', paddingLeft: 10 }}>${'· ' + line.slice(2)}</div>`);
    } else if (line.trim()) {
      parts.push(html`<div key=${i} style=${{ fontSize: 11, color: '#666', lineHeight: 1.5 }}>${line.replace(/^\*(.+)\*$/, '$1')}</div>`);
    }
    i++;
  }
  return html`<div>${parts}</div>`;
}

function FileItem({ name, content }) {
  const [open, setOpen] = useState(false);
  const hasContent = !!content;

  return html`<div>
    <div
      className="wiki-file${hasContent ? ' wiki-file-clickable' : ''}"
      onClick=${hasContent ? () => setOpen(o => !o) : null}
    >${slugToTitle(name)}</div>
    ${open && content && html`<div className="wiki-file-content">
      <${MarkdownContent} text=${content} />
    </div>`}
  </div>`;
}

function FolderItem({ folder }) {
  const [open, setOpen] = useState(false);
  const { name, count, files, contents } = folder;

  return html`<div className="wiki-folder">
    <div className="wiki-folder-header" onClick=${() => setOpen(o => !o)}>
      <span className="wiki-folder-name">${name}/</span>
      <span className="wiki-folder-count">${count}</span>
    </div>
    ${open && html`<div className="wiki-folder-children">
      ${files.map(f => html`<${FileItem}
        key=${f}
        name=${f}
        content=${contents[f] || null}
      />`)}
    </div>`}
  </div>`;
}

export function WikiBrowser() {
  return html`<div className="wiki-browser">
    ${WIKI_TREE.map(folder => html`<${FolderItem} key=${folder.name} folder=${folder} />`)}
  </div>`;
}
