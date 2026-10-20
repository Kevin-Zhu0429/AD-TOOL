import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown } from './markdown.js';

test('weekly report markdown: headings, tables, lists and paragraphs', () => {
  const blocks = parseMarkdown(`# 周报 10/12–10/18

**一句话：** 上周卖 64 件，
比前一周少 15%。

## 1. 全店

| 指标 | 上周 | 变化 |
|---|---:|:---:|
| 件数 | 64 | −14.7% |
| 访问量 \\| 日均 | 159 |

- 前一周有两个大单。
  - 子项
- 访问量日均 75→57

1. **补货：** 帆布平垫
2. 确认 16 条广告调整

> 注意：处理中

---
数据来源：网站`);
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'heading', 'table', 'list', 'list', 'quote', 'hr', 'paragraph']);
  assert.equal(blocks[1].text, '**一句话：** 上周卖 64 件， 比前一周少 15%。');
  assert.deepEqual(blocks[3].header, ['指标', '上周', '变化']);
  assert.deepEqual(blocks[3].aligns, [null, 'right', 'center']);
  // 少的格子补空,竖线可以转义
  assert.deepEqual(blocks[3].rows[1], ['访问量 | 日均', '159', '']);
  assert.deepEqual(blocks[4].items.map((item) => item.depth), [0, 1, 0]);
  assert.equal(blocks[5].ordered, true);
  assert.equal(blocks[6].text, '注意：处理中');
});

test('inline markdown keeps unsafe links as text', () => {
  assert.deepEqual(parseInline('a **b `c`** [d](https://x.top/#agent) [e](javascript:alert(1))'), [
    { type: 'text', text: 'a ' },
    { type: 'strong', children: [{ type: 'text', text: 'b ' }, { type: 'code', text: 'c' }] },
    { type: 'text', text: ' ' },
    { type: 'link', href: 'https://x.top/#agent', children: [{ type: 'text', text: 'd' }] },
    { type: 'text', text: ' ' },
    { type: 'text', text: '[e](javascript:alert(1)' },
    { type: 'text', text: ')' },
  ]);
});
