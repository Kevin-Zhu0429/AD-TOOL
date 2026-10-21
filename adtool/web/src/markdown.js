// 周报正文的 Markdown 解析:只认 Claude 写周报用到的几种写法(标题、段落、列表、表格、引用、分隔线,行内加粗、代码、链接),
// 解析成普通数据由 React 渲染,不拼 HTML,正文里的尖括号原样显示

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function cells(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out = [];
  let cell = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\' && body[index + 1] === '|') { cell += '|'; index += 1; } else if (char === '|') { out.push(cell.trim()); cell = ''; } else cell += char;
  }
  out.push(cell.trim());
  return out;
}

function align(sep) {
  return cells(sep).map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : null));
}

/** 整篇解析成块:heading / paragraph / list / table / quote / hr */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); index += 1; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: 'hr' }); index += 1; continue; }
    if (isTableRow(line) && TABLE_SEP.test(lines[index + 1] ?? '')) {
      const header = cells(line), aligns = align(lines[index + 1]);
      const rows = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index])) {
        const row = cells(lines[index]);
        rows.push(header.map((_, col) => row[col] ?? ''));
        index += 1;
      }
      blocks.push({ type: 'table', header, aligns: header.map((_, col) => aligns[col] ?? null), rows });
      continue;
    }
    if (LIST.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (index < lines.length && lines[index].trim()) {
        const match = LIST.exec(lines[index]);
        if (match) items.push({ text: match[3], depth: Math.min(3, Math.floor(match[1].replace(/\t/g, '  ').length / 2)) });
        else if (items.length) items[items.length - 1].text += ` ${lines[index].trim()}`;
        index += 1;
      }
      blocks.push({ type: 'list', ordered, start: ordered ? Number(/\d+/.exec(line)[0]) : 1, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const text = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) { text.push(lines[index].replace(/^\s*>\s?/, '')); index += 1; }
      blocks.push({ type: 'quote', text: text.join(' ').trim() });
      continue;
    }
    const text = [];
    while (index < lines.length && lines[index].trim() && !/^#{1,6}\s/.test(lines[index]) && !LIST.test(lines[index]) && !/^\s*>/.test(lines[index])
      && !(isTableRow(lines[index]) && TABLE_SEP.test(lines[index + 1] ?? ''))) {
      text.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: text.join(' ') });
  }
  return blocks;
}

const SAFE_URL = /^(https?:\/\/|#|\/)/i;

/** 行内:**加粗**、`代码`、[文字](链接),链接只认 http(s)、站内路径和 # 锚点 */
export function parseInline(text) {
  const out = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0, match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push({ type: 'text', text: text.slice(last, match.index) });
    if (match[1] != null) out.push({ type: 'strong', children: parseInline(match[1]) });
    else if (match[2] != null) out.push({ type: 'code', text: match[2] });
    else if (SAFE_URL.test(match[4])) out.push({ type: 'link', href: match[4], children: parseInline(match[3]) });
    else out.push({ type: 'text', text: match[0] });
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}
