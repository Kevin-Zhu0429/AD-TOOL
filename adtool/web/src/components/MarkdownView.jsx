import { useMemo } from 'react';
import { parseInline, parseMarkdown } from '../markdown.js';

function Nodes({ nodes }) {
  return nodes.map((part, index) => {
    if (part.type === 'strong') return <strong key={index}><Nodes nodes={part.children} /></strong>;
    if (part.type === 'code') return <code key={index}>{part.text}</code>;
    if (part.type === 'link') {
      const outside = /^https?:/i.test(part.href);
      return <a key={index} href={part.href} {...(outside ? { target: '_blank', rel: 'noopener noreferrer' } : {})}><Nodes nodes={part.children} /></a>;
    }
    return part.text;
  });
}

const Inline = ({ text }) => <Nodes nodes={parseInline(text)} />;

// 数字、金额、百分比、「64 / 75」这类格子右对齐
const NUMERIC = /^[−\-+~约]?\s*[$¥]?[\d,.]+\s*(%|件|天|个点)?(\s*\/\s*[−\-+]?[$¥]?[\d,.–]+\s*(%|件)?)?$/;

/** 周报正文:标题、段落、列表、表格(窄屏横向滚动)、引用 */
export default function MarkdownView({ text }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="md">{blocks.map((block, index) => {
    if (block.type === 'heading') {
      const Tag = `h${Math.min(4, block.level + 1)}`;
      return <Tag key={index}><Inline text={block.text} /></Tag>;
    }
    if (block.type === 'hr') return <hr key={index} />;
    if (block.type === 'quote') return <blockquote key={index}><Inline text={block.text} /></blockquote>;
    if (block.type === 'list') {
      const List = block.ordered ? 'ol' : 'ul';
      return <List key={index} {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}>
        {block.items.map((item, i) => <li key={i} className={item.depth ? `md-d${item.depth}` : undefined}><Inline text={item.text} /></li>)}</List>;
    }
    if (block.type === 'table') {
      // 没写对齐的列:大部分格子是数字就整列右对齐,一列里不忽左忽右
      const numeric = block.header.map((_, col) => {
        const values = block.rows.map((row) => row[col].trim()).filter((cell) => cell && !/^[–—-]$/.test(cell));
        return values.length > 0 && values.filter((cell) => NUMERIC.test(cell)).length * 2 >= values.length;
      });
      const align = (col) => block.aligns[col] ?? (numeric[col] ? 'right' : undefined);
      return <div key={index} className="scroll md-table"><table className="tbl">
        <thead><tr>{block.header.map((cell, col) => <th key={col} style={{ textAlign: align(col) }}><Inline text={cell} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, col) => <td key={col} className={numeric[col] ? 'md-num' : undefined} style={{ textAlign: align(col) }}><Inline text={cell} /></td>)}</tr>)}</tbody>
      </table></div>;
    }
    return <p key={index}><Inline text={block.text} /></p>;
  })}</div>;
}
