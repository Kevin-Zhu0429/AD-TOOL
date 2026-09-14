import { buildColIndex, createModelAssembler, detectLang, entityKindOf, metricsOf, num, parse } from './optCore.js';

const STREAM_SHEET_THRESHOLD = 256 * 1024 * 1024;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

function abortError() {
  return new DOMException('已取消读取文件', 'AbortError');
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function xmlText(value) {
  return String(value || '').replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, function (_, entity) {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (/^#x/i.test(entity)) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity[0] === '#') return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return _;
  });
}

function attr(source, name) {
  var match = source.match(new RegExp('(?:^|\\s)' + name.replace(':', '\\:') + '="([^"]*)"'));
  return match ? xmlText(match[1]) : '';
}

function normalizeZipPath(base, target) {
  if (target[0] === '/') return target.slice(1);
  var parts = (base + '/' + target).split('/');
  var out = [];
  parts.forEach(function (part) {
    if (!part || part === '.') return;
    if (part === '..') out.pop();
    else out.push(part);
  });
  return out.join('/');
}

function findSignature(bytes, signature) {
  for (var i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === (signature & 255) && bytes[i + 1] === ((signature >>> 8) & 255) &&
        bytes[i + 2] === ((signature >>> 16) & 255) && bytes[i + 3] === ((signature >>> 24) & 255)) return i;
  }
  return -1;
}

async function openZip(blob, signal) {
  checkAbort(signal);
  var tailStart = Math.max(0, blob.size - 65557);
  var tail = new Uint8Array(await blob.slice(tailStart).arrayBuffer());
  var end = findSignature(tail, ZIP_EOCD_SIGNATURE);
  if (end < 0) throw new Error('不是有效的 XLSX 文件，找不到 ZIP 目录。');
  var endView = new DataView(tail.buffer, tail.byteOffset + end, tail.byteLength - end);
  var entryCount = endView.getUint16(10, true);
  var directorySize = endView.getUint32(12, true);
  var directoryOffset = endView.getUint32(16, true);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的 XLSX 文件。');
  }
  checkAbort(signal);
  var directory = new Uint8Array(await blob.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
  var decoder = new TextDecoder('utf-8');
  var entries = new Map();
  var offset = 0;
  while (offset + 46 <= directory.length) {
    var view = new DataView(directory.buffer, directory.byteOffset + offset, directory.byteLength - offset);
    if (view.getUint32(0, true) !== ZIP_CENTRAL_SIGNATURE) break;
    var method = view.getUint16(10, true);
    var compressedSize = view.getUint32(20, true);
    var uncompressedSize = view.getUint32(24, true);
    var nameLength = view.getUint16(28, true);
    var extraLength = view.getUint16(30, true);
    var commentLength = view.getUint16(32, true);
    var localOffset = view.getUint32(42, true);
    var name = decoder.decode(directory.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { name: name, method: method, compressedSize: compressedSize,
      uncompressedSize: uncompressedSize, localOffset: localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  async function stream(entry) {
    checkAbort(signal);
    var local = new Uint8Array(await blob.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    var view = new DataView(local.buffer, local.byteOffset, local.byteLength);
    if (view.getUint32(0, true) !== ZIP_LOCAL_SIGNATURE) throw new Error('XLSX 文件中的工作表位置无效。');
    var nameLength = view.getUint16(26, true);
    var extraLength = view.getUint16(28, true);
    var start = entry.localOffset + 30 + nameLength + extraLength;
    var source = blob.slice(start, start + entry.compressedSize).stream();
    if (entry.method === 0) return source;
    if (entry.method === 8) return source.pipeThrough(new DecompressionStream('deflate-raw'));
    throw new Error('XLSX 使用了暂不支持的压缩方式：' + entry.method);
  }

  return { entries: entries, stream: stream };
}

async function readEntryText(zip, entry, signal) {
  checkAbort(signal);
  var stream = await zip.stream(entry);
  var reader = stream.getReader();
  var decoder = new TextDecoder('utf-8');
  var out = '';
  try {
    while (true) {
      checkAbort(signal);
      var part = await reader.read();
      if (part.done) break;
      out += decoder.decode(part.value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    reader.releaseLock();
  }
}

async function workbookSheets(zip, signal) {
  var workbookEntry = zip.entries.get('xl/workbook.xml');
  var relsEntry = zip.entries.get('xl/_rels/workbook.xml.rels');
  if (!workbookEntry || !relsEntry) throw new Error('XLSX 缺少工作簿目录。');
  var workbookXml = await readEntryText(zip, workbookEntry, signal);
  var relsXml = await readEntryText(zip, relsEntry, signal);
  var rels = {};
  var relRe = /<Relationship\b([^>]*?)\/?\s*>/g;
  var match;
  while ((match = relRe.exec(relsXml))) rels[attr(match[1], 'Id')] = attr(match[1], 'Target');
  var sheets = [];
  var sheetRe = /<sheet\b([^>]*?)\/?\s*>/g;
  while ((match = sheetRe.exec(workbookXml))) {
    var id = attr(match[1], 'r:id');
    var target = rels[id];
    if (!target) continue;
    var path = normalizeZipPath('xl', target);
    var entry = zip.entries.get(path);
    if (entry) sheets.push({ name: attr(match[1], 'name'), state: attr(match[1], 'state') || 'visible', path: path, entry: entry });
  }
  return sheets;
}

async function scanElements(zip, entry, tagName, signal, onElement, onChunk) {
  var stream = await zip.stream(entry);
  var reader = stream.getReader();
  var decoder = new TextDecoder('utf-8');
  var buffer = '';
  var loaded = 0;
  var startToken = '<' + tagName;
  var endToken = '</' + tagName + '>';
  try {
    while (true) {
      checkAbort(signal);
      var part = await reader.read();
      if (part.done) break;
      loaded += part.value.byteLength;
      buffer += decoder.decode(part.value, { stream: true });
      while (true) {
        var start = buffer.indexOf(startToken);
        if (start < 0) {
          buffer = buffer.slice(Math.max(0, buffer.length - startToken.length));
          break;
        }
        if (start > 0) buffer = buffer.slice(start);
        var openEnd = buffer.indexOf('>', startToken.length);
        if (openEnd < 0) {
          break;
        }
        if (buffer[openEnd - 1] === '/') {
          onElement(buffer.slice(0, openEnd + 1));
          buffer = buffer.slice(openEnd + 1);
          continue;
        }
        var end = buffer.indexOf(endToken, openEnd + 1);
        if (end < 0) {
          break;
        }
        var after = end + endToken.length;
        onElement(buffer.slice(0, after));
        buffer = buffer.slice(after);
      }
      if (onChunk) onChunk(loaded, entry.uncompressedSize);
    }
    buffer += decoder.decode();
    var start = buffer.indexOf(startToken);
    while (start >= 0) {
      var openEnd = buffer.indexOf('>', start + startToken.length);
      if (openEnd < 0) break;
      var selfClosing = buffer[openEnd - 1] === '/';
      var end = selfClosing ? openEnd + 1 : buffer.indexOf(endToken, openEnd + 1);
      if (end < 0) break;
      var after = selfClosing ? end : end + endToken.length;
      onElement(buffer.slice(start, after));
      buffer = buffer.slice(after);
      start = buffer.indexOf(startToken);
    }
  } finally {
    if (signal?.aborted) await reader.cancel().catch(function () {});
    reader.releaseLock();
  }
}

function richText(xml) {
  var out = '';
  var textRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  var match;
  while ((match = textRe.exec(xml))) out += xmlText(match[1]);
  return out;
}

async function sharedStrings(zip, entry, signal, progress) {
  if (!entry) return [];
  var strings = [];
  await scanElements(zip, entry, 'si', signal, function (element) {
    strings.push(richText(element));
  }, progress);
  return strings;
}

function columnIndex(ref) {
  var col = 0;
  for (var i = 0; i < ref.length; i++) {
    var code = ref.charCodeAt(i);
    if (code < 65 || code > 90) break;
    col = col * 26 + code - 64;
  }
  return col - 1;
}

function rowValues(element, strings) {
  var row = [];
  var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  var match;
  while ((match = cellRe.exec(element))) {
    var ref = attr(match[1], 'r');
    var col = columnIndex(ref);
    if (col < 0) continue;
    var type = attr(match[1], 't');
    var body = match[2] || '';
    var valueMatch = body.match(/<v>([\s\S]*?)<\/v>/);
    var value = valueMatch ? xmlText(valueMatch[1]) : null;
    if (type === 's' && value !== null) value = strings[Number(value)] ?? '';
    else if (type === 'inlineStr') value = richText(body);
    else if (type === 'b') value = value === '1';
    else if (!type && value !== null && value !== '') {
      var numeric = Number(value);
      if (Number.isFinite(numeric)) value = numeric;
    }
    row[col] = value;
  }
  return row;
}

async function worksheetRows(zip, sheet, strings, signal, onRow, progress) {
  var count = 0;
  await scanElements(zip, sheet.entry, 'row', signal, function (element) {
    count++;
    onRow(rowValues(element, strings), count);
  }, progress);
  return count;
}

function reportTerm(row, c) {
  if (c.searchTerm < 0 || !row[c.searchTerm]) return null;
  return {
    campaignId: String(row[c.campaignId] || ''),
    adGroupId: String(row[c.adGroupId] || ''),
    targetId: String(row[c.keywordId] || row[c.targetId] || ''),
    campaignName: String(row[c.campaignNameInfo] || ''),
    adGroupName: String(row[c.adGroupNameInfo] || ''),
    keywordText: row[c.keywordText] || row[c.targetExpr] || '',
    matchType: row[c.matchType] || '',
    term: String(row[c.searchTerm]),
    m: metricsOf(num(row[c.impressions]), num(row[c.clicks]), num(row[c.spend]),
      num(row[c.sales]), num(row[c.orders]), num(row[c.units]))
  };
}

function emitProgress(callback, stage, loaded, total, rows) {
  if (!callback) return;
  callback({ stage: stage, loaded: loaded, total: total,
    percent: total ? Math.min(100, Math.round(loaded / total * 100)) : null, rows: rows || 0 });
}

export async function parseBulkWorkbookFile(file, options) {
  options = options || {};
  var signal = options.signal;
  var progress = options.onProgress;
  var threshold = options.streamThresholdBytes ?? STREAM_SHEET_THRESHOLD;
  checkAbort(signal);

  if (!/\.xlsx$/i.test(file.name || '')) {
    emitProgress(progress, '正在读取工作簿', 0, file.size || 0, 0);
    var legacyBytes = new Uint8Array(await file.arrayBuffer());
    checkAbort(signal);
    return { model: parse(legacyBytes), raw: legacyBytes, sourceFile: file, streamed: false, largeFile: false };
  }

  var zip = await openZip(file, signal);
  var sheets = await workbookSheets(zip, signal);
  var mainSheet = sheets.find(function (sheet) {
    return sheet.name === '商品推广活动' || sheet.name === 'Sponsored Products Campaigns';
  });
  if (!mainSheet) throw new Error('没找到「商品推广活动」工作表，请确认这是商品推广(SP)批量表。');

  if (mainSheet.entry.uncompressedSize < threshold) {
    emitProgress(progress, '正在读取工作簿', 0, file.size || 0, 0);
    var bytes = new Uint8Array(await file.arrayBuffer());
    checkAbort(signal);
    return { model: parse(bytes), raw: bytes, sourceFile: file, streamed: false, largeFile: false };
  }

  var stringsEntry = zip.entries.get('xl/sharedStrings.xml');
  var strings = await sharedStrings(zip, stringsEntry, signal, function (loaded, total) {
    emitProgress(progress, '正在读取文本索引', loaded, total, 0);
  });

  var rows = [];
  var header = null;
  var columns = null;
  var assembler = null;
  await worksheetRows(zip, mainSheet, strings, signal, function (row, count) {
    if (count === 1) {
      header = row;
      columns = buildColIndex(header);
      if (columns.entity < 0) throw new Error('表头缺少「实体层级」列，无法解析。');
      assembler = createModelAssembler(columns);
      return;
    }
    if (!row.length || row.every(function (value) { return value === null || value === ''; })) return;
    while (row.length < header.length) row.push(null);
    var record = { i: rows.length, kind: entityKindOf(row[columns.entity]), d: row };
    rows.push(record);
    assembler.add(record);
  }, function (loaded, total) {
    emitProgress(progress, '正在解析商品推广活动', loaded, total, rows.length);
  });
  if (!header || !assembler) throw new Error('「商品推广活动」工作表没有有效表头。');

  var searchTerms = [];
  var searchSheet = sheets.find(function (sheet) {
    return ['商品推广搜索词报告', 'SP Search Term Report', 'Sponsored Products Search Term Report'].includes(sheet.name);
  });
  if (searchSheet) {
    var searchColumns = null;
    await worksheetRows(zip, searchSheet, strings, signal, function (row, count) {
      if (count === 1) { searchColumns = buildColIndex(row); return; }
      var term = reportTerm(row, searchColumns);
      if (term) searchTerms.push(term);
    }, function (loaded, total) {
      emitProgress(progress, '正在解析搜索词报告', loaded, total, searchTerms.length);
    });
  }

  var currency = '';
  var portfolioSheet = sheets.find(function (sheet) { return sheet.name === '广告组合' || sheet.name === 'Portfolios'; });
  if (portfolioSheet) {
    var currencyColumn = -1;
    await worksheetRows(zip, portfolioSheet, strings, signal, function (row, count) {
      if (count === 1) {
        row.forEach(function (heading, index) {
          if (heading && /预算的货币代码|Budget Currency Code/i.test(String(heading))) currencyColumn = index;
        });
      } else if (!currency && currencyColumn >= 0 && row[currencyColumn]) currency = String(row[currencyColumn]).trim();
    });
  }

  checkAbort(signal);
  var model = assembler.finish();
  model.currency = currency;
  model.header = header;
  model.colIdx = columns;
  model.lang = detectLang(header);
  model.sheetName = mainSheet.name;
  model.searchTerms = searchTerms;
  model.rows = rows;
  model.sheetNames = sheets.map(function (sheet) { return sheet.name; });
  model.dropSheets = model.sheetNames.filter(function (name) {
    return name !== mainSheet.name && name !== '广告组合' && name !== 'Portfolios';
  });
  model.largeFile = true;
  emitProgress(progress, '正在完成索引', 1, 1, rows.length);
  return { model: model, raw: null, sourceFile: file, streamed: true, largeFile: true };
}

export { STREAM_SHEET_THRESHOLD };
