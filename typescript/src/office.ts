import { inflateRawSync } from 'node:zlib';
import { posix, extname } from 'node:path';
import { Parser } from 'htmlparser2';
import { ReadError } from './errors.js';
import { BUILTIN_FORMATS, MAX_FORMATS, MAX_FORMAT_LENGTH, displayNumber } from './excel-formats.js';
export const OFFICE_MIMES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024, MAX_TEXT_BYTES = 8 * 1024 * 1024;
const WORD = ['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'];
const SHEET = ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'];
const REL = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const ALTERNATE = '{http://schemas.openxmlformats.org/markup-compatibility/2006}AlternateContent';
export type Warning = {
  code: string;
  message: string;
  count?: number;
};
function invalid(): never {
  throw new ReadError('NOT_SUPPORTED');
}
function large(): never {
  throw new ReadError('RESPONSE_TOO_LARGE');
}
function types(name: unknown, mime: unknown) {
  return [typeof name === 'string' ? extname(name).toLowerCase() : '', typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : ''];
}
export function isOfficeAttachment(name: unknown, mime: unknown) {
  const [suffix, declared] = types(name, mime);
  return !['.doc', '.xls', '.xlsm', '.docm'].includes(suffix) && (['.docx', '.xlsx'].includes(suffix) || Object.values(OFFICE_MIMES).includes(declared));
}
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let crc = i;
  for (let j = 0; j < 8; j++)
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(raw: Buffer) {
  let crc = 0xffffffff;
  for (const byte of raw)
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function hasDeclaration(raw: Buffer) {
  return /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(raw.toString('latin1').replace(/\0/g, ''));
}
function openPackage(raw: Buffer): Map<string, Buffer> {
  try {
    let end = -1;
    for (let i = raw.length - 22; i >= Math.max(0, raw.length - 65557); i--)
      if (raw.readUInt32LE(i) === 0x06054b50 && i + 22 + raw.readUInt16LE(i + 20) === raw.length) {
        end = i;
        break;
      }
    if (end < 0 || raw.readUInt16LE(end + 4) || raw.readUInt16LE(end + 6))
      invalid();
    const count = raw.readUInt16LE(end + 10), centralSize = raw.readUInt32LE(end + 12), centralStart = raw.readUInt32LE(end + 16);
    if (count !== raw.readUInt16LE(end + 8) || count === 65535 || centralStart + centralSize !== end)
      invalid();
    if (count > 512)
      large();
    const parts = new Map<string, Buffer>(), names = new Set<string>(), ranges: [
      number,
      number
    ][] = [];
    let offset = centralStart, total = 0;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > end || raw.readUInt32LE(offset) !== 0x02014b50)
        invalid();
      const flags = raw.readUInt16LE(offset + 8), compression = raw.readUInt16LE(offset + 10), crc = raw.readUInt32LE(offset + 16);
      const compressed = raw.readUInt32LE(offset + 20), size = raw.readUInt32LE(offset + 24), nameSize = raw.readUInt16LE(offset + 28), extra = raw.readUInt16LE(offset + 30), comment = raw.readUInt16LE(offset + 32);
      const mode = raw.readUInt32LE(offset + 38) >>> 16, local = raw.readUInt32LE(offset + 42);
      if (offset + 46 + nameSize + extra + comment > end || raw.readUInt16LE(offset + 34))
        invalid();
      const nameBytes = raw.subarray(offset + 46, offset + 46 + nameSize);
      const name = flags & 0x800 ? new TextDecoder('utf-8', { fatal: true }).decode(nameBytes) : nameBytes.toString('latin1');
      const path = name.replace(/\/$/, '');
      if (!path || name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name) || name.includes('\0') || path.split('/').some(s => ['', '.', '..'].includes(s)) || (mode & 0xf000) === 0xa000 || (flags & 1) || names.has(name) || ![0, 8].includes(compression))
        invalid();
      names.add(name);
      if (total + size > MAX_UNCOMPRESSED_BYTES)
        large();
      if (local + 30 > centralStart || raw.readUInt32LE(local) !== 0x04034b50 || raw.readUInt16LE(local + 6) !== flags || raw.readUInt16LE(local + 8) !== compression)
        invalid();
      const localName = raw.readUInt16LE(local + 26), localExtra = raw.readUInt16LE(local + 28), start = local + 30 + localName + localExtra;
      if (start + compressed > centralStart || !nameBytes.equals(raw.subarray(local + 30, local + 30 + localName)))
        invalid();
      if (!(flags & 8) && (raw.readUInt32LE(local + 14) !== crc || raw.readUInt32LE(local + 18) !== compressed || raw.readUInt32LE(local + 22) !== size))
        invalid();
      if (ranges.some(([a, b]) => local < b && start + compressed > a))
        invalid();
      ranges.push([local, start + compressed]);
      let data: Buffer;
      try {
        data = compression === 0 ? Buffer.from(raw.subarray(start, start + compressed)) : inflateRawSync(raw.subarray(start, start + compressed), { maxOutputLength: MAX_UNCOMPRESSED_BYTES - total + 1 });
      }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE')
          large();
        invalid();
      }
      total += data.length;
      if (total > MAX_UNCOMPRESSED_BYTES)
        large();
      if (data.length !== size || crc32(data) !== crc)
        invalid();
      if (/\.(xml|rels)$/i.test(name) && hasDeclaration(data))
        invalid();
      if (!name.endsWith('/'))
        parts.set(name, data);
      offset += 46 + nameSize + extra + comment;
    }
    if (offset !== end || [...parts.keys()].some(name => name.toLowerCase().endsWith('vbaproject.bin')))
      invalid();
    if (parts.has('[Content_Types].xml')) {
      const root = xml(parts.get('[Content_Types].xml')!);
      namespace(root, 'Types', ['http://schemas.openxmlformats.org/package/2006/content-types']);
      if (root.children.some(n => /macroenabled|vbaproject/i.test(n.attrs.ContentType ?? '')))
        invalid();
    }
    return parts;
  }
  catch (error) {
    if (error instanceof ReadError)
      throw error;
    invalid();
  }
}
type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  text: string | null;
  children: XmlNode[];
};
function decodeXml(raw: Buffer): string {
  try {
    if (raw.length >= 4 && (raw.subarray(0, 4).equals(Buffer.from([255, 254, 0, 0])) || raw.subarray(0, 4).equals(Buffer.from([0, 0, 254, 255])) || raw.subarray(0, 4).equals(Buffer.from([60, 0, 0, 0])) || raw.subarray(0, 4).equals(Buffer.from([0, 0, 0, 60])))) {
      const little = raw[0] === 255 || raw[0] === 60;
      const start = raw[0] === 255 || raw[2] === 254 ? 4 : 0;
      if ((raw.length - start) % 4)
        invalid();
      const output: string[] = [];
      for (let offset = start; offset < raw.length; offset += 4) {
        const code = little ? raw.readUInt32LE(offset) : raw.readUInt32BE(offset);
        if (code > 0x10ffff || code >= 0xd800 && code <= 0xdfff)
          invalid();
        output.push(String.fromCodePoint(code));
      }
      return output.join('');
    }
    if (raw.subarray(0, 2).equals(Buffer.from([255, 254])) || raw.subarray(0, 4).equals(Buffer.from([60, 0, 63, 0])))
      return new TextDecoder('utf-16le', { fatal: true }).decode(raw);
    if (raw.subarray(0, 2).equals(Buffer.from([254, 255])) || raw.subarray(0, 4).equals(Buffer.from([0, 60, 0, 63])))
      return new TextDecoder('utf-16be', { fatal: true }).decode(raw);
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  }
  catch {
    invalid();
  }
}
function xml(raw: Buffer): XmlNode {
  if (hasDeclaration(raw))
    invalid();
  let source = decodeXml(raw).replace(/\r\n?/g, '\n');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(source))
    invalid();
  // Check well-formedness before the forgiving HTML tokenizer handles entity decoding.
  const names: string[] = [];
  let offset = 0, roots = 0, nodes = 0;
  const entity = /&(?!(?:amp|lt|gt|apos|quot|#\d+|#x[0-9a-fA-F]+);)/;
  const replacements: [number, number, string][] = [];
  function checkEntities(text: string) {
    if (entity.test(text))
      invalid();
    for (const match of text.matchAll(/&#(\d+|x[0-9a-fA-F]+);/g)) {
      const code = match[1].startsWith('x') ? Number.parseInt(match[1].slice(1), 16) : Number(match[1]);
      if (!(code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff))
        invalid();
    }
  }
  while (offset < source.length) {
    const next = source.indexOf('<', offset), stop = next < 0 ? source.length : next, text = source.slice(offset, stop);
    checkEntities(text);
    if (text.includes(']]>') || (!names.length && text.trim()))
      invalid();
    offset = stop;
    if (next < 0)
      break;
    if (source.startsWith('<!--', offset)) {
      const end = source.indexOf('-->', offset + 4);
      if (end < 0 || source.slice(offset + 4, end).includes('--'))
        invalid();
      offset = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', offset)) {
      const end = source.indexOf(']]>', offset + 9);
      if (end < 0 || !names.length)
        invalid();
      offset = end + 3;
      continue;
    }
    if (source.startsWith('<?', offset)) {
      const end = source.indexOf('?>', offset + 2);
      if (end < 0)
        invalid();
      offset = end + 2;
      continue;
    }
    const close = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(source.slice(offset));
    if (close) {
      if (names.pop() !== close[1])
        invalid();
      offset += close[0].length;
      continue;
    }
    const open = /^<([A-Za-z_][\w.:-]*)/.exec(source.slice(offset));
    if (!open)
      invalid();
    let at = offset + open[0].length;
    const attrs = new Set<string>();
    while (true) {
      const rest = source.slice(at), ending = /^\s*(\/?>)/.exec(rest);
      if (ending) {
        if (!names.length && ++roots > 1)
          invalid();
        if (++nodes > 100000 || names.length + 1 > 256)
          large();
        if (ending[1] === '>')
          names.push(open[1]);
        offset = at + ending[0].length;
        break;
      }
      const attr = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
      if (!attr || attrs.has(attr[1]))
        invalid();
      const value = attr[2] ?? attr[3];
      checkEntities(value);
      if (/[\t\n]/.test(value)) {
        const valueStart = at + attr[0].indexOf(attr[2] !== undefined ? '"' : "'") + 1;
        replacements.push([valueStart, valueStart + value.length, value.replace(/[\t\n]/g, ' ')]);
      }
      attrs.add(attr[1]);
      at += attr[0].length;
    }
  }
  if (names.length || roots !== 1)
    invalid();
  if (replacements.length) {
    const fragments: string[] = [];
    let previous = 0;
    for (const [start, end, value] of replacements) {
      fragments.push(source.slice(previous, start), value);
      previous = end;
    }
    fragments.push(source.slice(previous));
    source = fragments.join('');
  }
  const stack: {
    node: XmlNode;
    namespaces: Record<string, string>;
  }[] = [];
  let root: XmlNode | undefined;
  const expand = (name: string, ns: Record<string, string>, attribute = false) => {
    const pieces = name.split(':');
    if (pieces.length > 2)
      invalid();
    if (pieces.length === 2) {
      if (!ns[pieces[0]])
        invalid();
      return '{' + ns[pieces[0]] + '}' + pieces[1];
    }
    return !attribute && ns[''] ? '{' + ns[''] + '}' + name : name;
  };
  const parser = new Parser({
    onopentag(name, attrs) {
      const ns = Object.assign(Object.create(null), stack.at(-1)?.namespaces ?? { xml: 'http://www.w3.org/XML/1998/namespace' });
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'xmlns')
          ns[''] = value;
        else if (key.startsWith('xmlns:'))
          ns[key.slice(6)] = value;
      }
      const attributes: Record<string, string> = Object.create(null);
      for (const [key, value] of Object.entries(attrs))
        if (key !== 'xmlns' && !key.startsWith('xmlns:')) {
          const expanded = expand(key, ns, true);
          if (Object.hasOwn(attributes, expanded))
            invalid();
          attributes[expanded] = value;
        }
      const node: XmlNode = {
        tag: expand(name, ns), attrs: attributes, text: null, children: []
      };
      if (stack.length)
        stack.at(-1)!.node.children.push(node);
      else
        root = node;
      stack.push({ node, namespaces: ns });
    },
    ontext(value) {
      const node = stack.at(-1)?.node;
      if (node && !node.children.length)
        node.text = (node.text ?? '') + value;
    },
    onclosetag() {
      stack.pop();
    }, onerror() {
      invalid();
    },
  }, { xmlMode: true, decodeEntities: true });
  parser.end(source);
  if (!root)
    invalid();
  return root;
}
function namespace(root: XmlNode, tag: string, allowed: string[]) {
  const ns = allowed.find(n => root.tag === '{' + n + '}' + tag);
  if (!ns)
    invalid();
  return '{' + ns + '}';
}
const children = (node: XmlNode | undefined, tag: string) => node?.children.filter(c => c.tag === tag) ?? [];
const child = (node: XmlNode | undefined, tag: string) => children(node, tag)[0];
function descendants(root: XmlNode) {
  const all: XmlNode[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    all.push(n);
    stack.push(...n.children);
  }
  return all;
}
type Parts = Map<string, Buffer>;
function relationships(parts: Parts, warnings: Warning[]) {
  const relations = new Map<string, Map<string, Record<string, string>>>();
  let external = false;
  for (const [name, raw] of parts) {
    if (!name.endsWith('.rels'))
      continue;
    const root = xml(raw), ns = namespace(root, 'Relationships', [PACKAGE_REL]), entries = new Map<string, Record<string, string>>();
    for (const item of children(root, ns + 'Relationship')) {
      const key = item.attrs.Id;
      if (!key || entries.has(key))
        invalid();
      entries.set(key, item.attrs);
      external ||= item.attrs.TargetMode === 'External';
    }
    relations.set(name, entries);
  }
  if (external)
    warnings.push({ code: 'external_relationships_not_read', message: '附件包含外部关系；未请求外链、更新外部数据或读取外部内容。' });
  return relations;
}
function textOutput() {
  const output: string[] = [];
  let total = 0;
  return { append(value: string) {
      total += Buffer.byteLength(value);
      if (total > MAX_TEXT_BYTES)
        large();
      output.push(value);
    }, text() {
      return output.join('');
    } };
}
function docx(parts: Parts, warnings: Warning[]) {
  const root = xml(parts.get('word/document.xml')!), w = namespace(root, 'document', WORD), body = child(root, w + 'body');
  if (!body)
    invalid();
  if (descendants(body).some(n => n.tag === ALTERNATE))
    warnings.push({ code: 'docx_alternate_content_not_read', message: '主文档包含互斥的替代内容分支；已整块跳过，未判定 Choice/Fallback 的有效分支。' });
  const out = textOutput(), stack: [
    XmlNode,
    boolean
  ][] = [[body, false]];
  while (stack.length) {
    const [node, closing] = stack.pop()!, tag = node.tag;
    if (closing) {
      if ([w + 'p', w + 'tr'].includes(tag))
        out.append('\n');
      else if (tag === w + 'tc')
        out.append('\t');
      else if ([w + 'del', w + 'moveFrom'].includes(tag))
        out.append(']');
      continue;
    }
    if ([w + 'drawing', w + 'pict', w + 'object', w + 'txbxContent', ALTERNATE].includes(tag))
      continue;
    if ([w + 't', w + 'delText'].includes(tag))
      out.append(node.text ?? '');
    else if (tag === w + 'tab')
      out.append('\t');
    else if ([w + 'br', w + 'cr'].includes(tag))
      out.append('\n');
    else if ([w + 'del', w + 'moveFrom'].includes(tag))
      out.append('[删除线: ');
    stack.push([node, true]);
    for (let i = node.children.length - 1; i >= 0; i--)
      stack.push([node.children[i], false]);
  }
  return out.text();
}
function coordinate(value: string): [
  number,
  number
] {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value);
  if (!match)
    invalid();
  let column = 0;
  for (const character of match[1])
    column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16384 || row > 1048576)
    invalid();
  return [row, column];
}
function styleId(value: string) {
  if (!/^[0-9]{1,10}$/.test(value))
    invalid();
  return Number(value);
}
function numberFormats(parts: Parts): (string | null | undefined)[] {
  if (!parts.has('xl/styles.xml'))
    return [];
  const root = xml(parts.get('xl/styles.xml')!), ns = namespace(root, 'styleSheet', SHEET);
  const custom = children(child(root, ns + 'numFmts'), ns + 'numFmt'), styles = children(child(root, ns + 'cellXfs'), ns + 'xf'), bases = children(child(root, ns + 'cellStyleXfs'), ns + 'xf');
  if (Math.max(custom.length, styles.length, bases.length) > MAX_FORMATS)
    large();
  const formats = new Map<number, string | null>(Object.entries(BUILTIN_FORMATS).map(([k, v]) => [Number(k), v])), seen = new Set<number>();
  for (const item of custom) {
    const key = styleId(item.attrs.numFmtId ?? '');
    if (seen.has(key))
      invalid();
    seen.add(key);
    const code = item.attrs.formatCode;
    if (code === undefined)
      invalid();
    formats.set(key, [...code].length <= MAX_FORMAT_LENGTH ? code : null);
  }
  return styles.map(item => {
    const key = styleId(item.attrs.numFmtId ?? '0'), apply = item.attrs.applyNumberFormat;
    let baseKey = 0;
    if (apply !== undefined && !['0', '1', 'false', 'true'].includes(apply))
      invalid();
    if (item.attrs.xfId !== undefined) {
      const base = styleId(item.attrs.xfId);
      if (base >= bases.length) {
        if (base !== 0)
          return null;
      }
      else
        baseKey = styleId(bases[base].attrs.numFmtId ?? '0');
    }
    if ((['0', 'false'].includes(apply) && key !== baseKey) || (apply === undefined && key !== baseKey && baseKey !== 0))
      return null;
    return formats.get(key);
  });
}
type Merge = {
  ref: string;
  start: [
    number,
    number
  ];
  end: [
    number,
    number
  ];
};
function merges(root: XmlNode, ns: string): Merge[] {
  const items = children(child(root, ns + 'mergeCells'), ns + 'mergeCell');
  if (items.length > 1024)
    large();
  const ranges: Merge[] = [];
  for (const item of items) {
    const ref = item.attrs.ref ?? '', values = ref.split(':');
    if (values.length !== 2)
      invalid();
    const start = coordinate(values[0]), end = coordinate(values[1]);
    if (start[0] > end[0] || start[1] > end[1] || (start[0] === end[0] && start[1] === end[1]))
      invalid();
    if (ranges.some(r => !(end[0] < r.start[0] || start[0] > r.end[0] || end[1] < r.start[1] || start[1] > r.end[1])))
      invalid();
    ranges.push({
      ref, start, end
    });
  }
  return ranges;
}
function worksheetTarget(target: string) {
  if (!target || /^[A-Za-z][A-Za-z\d+.-]*:/.test(target) || target.startsWith('//') || /[?#\\\0]/.test(target) || target.split('/').includes('..'))
    invalid();
  const path = posix.normalize(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
  if (!path.startsWith('xl/worksheets/') || !path.endsWith('.xml'))
    invalid();
  return path;
}
function stringText(node: XmlNode | undefined, ns: string) {
  return (node?.children ?? []).flatMap(n => n.tag === ns + 't' ? [n] : n.tag === ns + 'r' ? children(n, ns + 't') : []).map(n => n.text ?? '').join('');
}
const WARNING_MESSAGES: Record<string, string> = {
  xlsx_number_format_unresolved: '部分数字的样式引用、内置地区格式或样式继承无法可靠解析；保留 raw 并标记格式未还原。',
  xlsx_number_format_limit: '部分数字格式超过长度、精度或显示长度限制；保留 raw 并标记格式未还原。',
  xlsx_numeric_value_limit_or_invalid: '部分样式数字超出 256 字符、十进制指数 ±308 的安全边界，或不是有效数字；保留 raw。',
  xlsx_number_format_unsupported: '部分格式包含复杂条件、地区标记、分数、宽度填充或其他不支持的语义；保留 raw 并标记格式未还原。',
  excel_fictitious_leap_day: '1900 日期系统的序号 60 对应 Excel 虚构的 1900-02-29；已明确标记，并非真实公历日期。',
  xlsx_inherited_or_conditional_styles_not_read: '检测到行列样式继承或条件格式；行列继承未还原，无显式样式的数字保留 raw。条件格式未应用，显式样式只展示基础格式。',
  xlsx_merge_value_conflict: '合并范围的非锚点仍有值或公式；已单独保留并标记冲突，未吞并到左上角。',
  xlsx_merge_anchor_value_missing: '部分合并范围的左上角锚点未存储、为空白或公式缓存缺失；范围标记不代表该处存在可读取值。',
};
function xlsx(parts: Parts, rels: ReturnType<typeof relationships>, warnings: Warning[]) {
  const root = xml(parts.get('xl/workbook.xml')!), s = namespace(root, 'workbook', SHEET), sheets = child(root, s + 'sheets');
  if (!sheets?.children.length)
    invalid();
  const system = child(root, s + 'workbookPr')?.attrs.date1904 ?? '0';
  if (!['0', '1', 'false', 'true'].includes(system))
    invalid();
  const date1904 = ['1', 'true'].includes(system);
  const formats = numberFormats(parts), counts = new Map<string, number>(), add = (code: string) => counts.set(code, (counts.get(code) ?? 0) + 1);
  let shared: string[] = [];
  if (parts.has('xl/sharedStrings.xml')) {
    const strings = xml(parts.get('xl/sharedStrings.xml')!), ns = namespace(strings, 'sst', SHEET);
    shared = children(strings, ns + 'si').map(n => stringText(n, ns));
  }
  const relations = rels.get('xl/_rels/workbook.xml.rels'), out = textOutput(), seenSheets = new Set<string>(), seenTargets = new Set<string>();
  let missing = 0, charts = 0;
  for (const sheet of children(sheets, s + 'sheet')) {
    const name = sheet.attrs.name, id = REL.map(ns => sheet.attrs['{' + ns + '}id']).find(Boolean), relation = id ? relations?.get(id) : undefined;
    if (!name || seenSheets.has(name) || !relation)
      invalid();
    seenSheets.add(name);
    if (relation.TargetMode === 'External')
      continue;
    if (REL.some(ns => relation.Type === ns + '/chartsheet')) {
      charts++;
      continue;
    }
    if (!REL.some(ns => relation.Type === ns + '/worksheet'))
      invalid();
    const target = worksheetTarget(relation.Target ?? '');
    if (!parts.has(target) || seenTargets.has(target))
      invalid();
    const wsRoot = xml(parts.get(target)!), ws = namespace(wsRoot, 'worksheet', SHEET);
    out.append((seenTargets.size ? '\n' : '') + '[Sheet: ' + name + ']');
    seenTargets.add(target);
    const ranges = merges(wsRoot, ws), anchors = new Set(ranges.map(r => r.ref.split(':')[0])), anchorStates = new Map<string, string>(), seenCells = new Set<string>();
    const rows = children(child(wsRoot, ws + 'sheetData'), ws + 'row');
    const inherited = rows.some(n => n.attrs.s !== undefined) || children(child(wsRoot, ws + 'cols'), ws + 'col').some(n => n.attrs.style !== undefined);
    if (inherited || child(wsRoot, ws + 'conditionalFormatting'))
      add('xlsx_inherited_or_conditional_styles_not_read');
    for (const cell of rows.flatMap(n => children(n, ws + 'c'))) {
      const coord = cell.attrs.r ?? '', position = coordinate(coord);
      if (seenCells.has(coord))
        invalid();
      seenCells.add(coord);
      let value = child(cell, ws + 'v')?.text ?? null;
      const kind = cell.attrs.t ?? 'n', formula = !!child(cell, ws + 'f');
      const conflict = ranges.some(({ start, end }) => (start[0] !== position[0] || start[1] !== position[1]) && start[0] <= position[0] && position[0] <= end[0] && start[1] <= position[1] && position[1] <= end[1]);
      let mark = '';
      if (formula && value === null) {
        missing++;
        if (anchors.has(coord))
          anchorStates.set(coord, '公式缓存缺失');
        if (conflict) {
          mark = ' [合并冲突: 非锚点有公式，已保留]';
          add('xlsx_merge_value_conflict');
        }
        out.append('\n' + coord + '\t[公式缓存缺失]' + mark);
        continue;
      }
      if (kind === 's') {
        if (value === null || !/^[0-9]{1,10}$/.test(value) || Number(value) >= shared.length)
          invalid();
        value = shared[Number(value)];
      }
      else if (kind === 'inlineStr')
        value = stringText(child(cell, ws + 'is'), ws);
      else if (kind === 'b') {
        if (value !== '0' && value !== '1')
          invalid();
        value = value === '1' ? 'TRUE' : 'FALSE';
      }
      else if (!['n', 'str', 'e', 'd'].includes(kind))
        invalid();
      if (anchors.has(coord))
        anchorStates.set(coord, value !== null && value !== '' ? '已提取' : '空白（无值）');
      if (conflict && (value === null || value === '') && !formula)
        continue;
      if (conflict && (value !== null || formula)) {
        mark = ' [合并冲突: 非锚点有值，已保留]';
        add('xlsx_merge_value_conflict');
      }
      if (kind === 'n' && value !== null) {
        const style = cell.attrs.s, styleIndex = style === undefined ? 0 : styleId(style);
        let code = formats.length || style !== undefined ? formats[styleIndex] : 'General';
        if (style === undefined && inherited)
          code = undefined;
        const [display, warning] = displayNumber(value, code, date1904);
        value = display;
        if (warning)
          add(warning);
      }
      if (value !== null)
        out.append('\n' + coord + '\t' + value + mark);
    }
    for (const { ref } of ranges) {
      const anchor = ref.split(':')[0], state = anchorStates.get(anchor) ?? '缺失（未存储单元格）';
      if (state !== '已提取')
        add('xlsx_merge_anchor_value_missing');
      out.append('\n[Merge: ' + ref + '; anchor=' + anchor + '; 锚点值=' + state + '; 覆盖范围=' + ref + '; 空白覆盖格不是独立值]');
    }
  }
  if (!seenTargets.size)
    invalid();
  if (charts)
    warnings.push({
      code: 'chart_sheets_not_read', count: charts, message: '工作簿包含图表工作表；未读取其视觉内容或图表数据。'
    });
  if (missing)
    warnings.push({
      code: 'formula_cache_missing', count: missing, message: '部分公式没有缓存值；只标记缺失，未计算或执行公式。'
    });
  for (const [code, count] of [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    warnings.push({
      code, count, message: WARNING_MESSAGES[code]
    });
  return out.text();
}
export function pageAttachmentText(text: string, textOffset = 0, maxTextChars = 12000) {
  if (!Number.isSafeInteger(textOffset) || textOffset < 0 || !Number.isSafeInteger(maxTextChars) || maxTextChars < 1 || maxTextChars > 30000)
    throw new ReadError('INVALID_ARGUMENT');
  let total = 0, startIndex = text.length, endIndex = text.length;
  for (let index = 0; index < text.length;) {
    if (total === textOffset)
      startIndex = index;
    if (total === textOffset + maxTextChars)
      endIndex = index;
    const code = text.codePointAt(index)!;
    index += code > 0xffff ? 2 : 1;
    total++;
  }
  if (textOffset > total)
    throw new ReadError('INVALID_ARGUMENT');
  const end = Math.min(total, textOffset + maxTextChars);
  return { text: text.slice(startIndex, endIndex), content: {
      text_offset: textOffset, returned_chars: end - textOffset, total_chars: total, next_offset: end < total ? end : null, is_full_document: textOffset === 0 && end === total
    } };
}
export function readOfficeAttachment(raw: Buffer, name: unknown, mime: unknown, textOffset = 0, maxTextChars = 12000) {
  if (!Number.isSafeInteger(textOffset) || textOffset < 0 || !Number.isSafeInteger(maxTextChars) || maxTextChars < 1 || maxTextChars > 30000)
    throw new ReadError('INVALID_ARGUMENT');
  if (!isOfficeAttachment(name, mime))
    invalid();
  if (!Buffer.isBuffer(raw) || !raw.length)
    throw new ReadError('CONTENT_INCOMPLETE');
  if (raw.length > 4 * 1024 * 1024)
    large();
  if (raw.length < 4 || raw.readUInt32LE(0) !== 0x04034b50)
    invalid();
  const parts = openPackage(raw);
  const word = parts.has('word/document.xml'), sheet = parts.has('xl/workbook.xml');
  if (word === sheet)
    invalid();
  const format = word ? 'docx' : 'xlsx', [suffix, declared] = types(name, mime);
  if (['.docx', '.xlsx'].includes(suffix) && suffix !== '.' + format)
    invalid();
  if (!['.docx', '.xlsx'].includes(suffix) && declared !== OFFICE_MIMES[format])
    invalid();
  const warnings: Warning[] = [{ code: 'office_text_only', message: word ? '结果仅为抽取文字，不是视觉全文；图片、图表、布局、格式和嵌入对象未读取。' : '结果仅为抽取文字，不是视觉全文；图片、图表、视觉布局和嵌入对象未读取。' }];
  if (declared && declared !== OFFICE_MIMES[format])
    warnings.push({ code: 'suffix_mime_mismatch', message: '声明 MIME 与实际 OpenXML 格式不一致；按已校验的内部文档格式抽取。' });
  const rels = relationships(parts, warnings), text = word ? docx(parts, warnings) : xlsx(parts, rels, warnings);
  const included = word ? ['main_body_paragraphs', 'table_text', 'tabs_and_breaks', 'marked_deleted_revisions'] : [
    'sheet_names', 'sparse_cell_coordinates', 'strings', 'raw_values', 'cached_formula_values', 'common_number_and_date_format_display', '1900_and_1904_date_systems', 'merged_ranges_and_anchors'
  ];
  const notRead = word ? [
    'images', 'floating_text_and_charts', 'headers_and_footers', 'comments', 'footnotes_and_endnotes', 'embedded_objects', 'layout_and_formatting', 'field_instructions', 'external_relationships', 'alternate_content_branches'
  ] : [
    'images_and_charts', 'comments', 'complex_or_locale_number_formats', 'row_column_and_conditional_styles', 'visual_styles_and_layout', 'layout_and_merged_cell_rendering', 'external_data', 'formula_calculation', 'defined_names_and_workbook_metadata'
  ];
  warnings.push({ code: word ? 'docx_scope_limited' : 'xlsx_scope_limited', message: word ? '只抽取主文档段落及表格文字；页眉页脚、批注、脚注尾注、浮动对象及字段指令未读取。删除修订以删除线标记。' : '读取稀疏单元格及合并范围锚点；常见数字/日期/时间格式给出展示值及 raw，日期附明确公历 date 与 1900/1904 system，General 保持原文。采用固定小数点、千分位和英文月份/星期，不复制本机地区或列宽渲染；复杂格式回退 raw。公式只读取可能过时的缓存，不计算；图表及批注未读取。' });
  return {
    ...pageAttachmentText(text, textOffset, maxTextChars), media_type: OFFICE_MIMES[format], format, warnings, scope: {
      kind: 'extracted_text', included, not_read: notRead, visual_full_document: false
    }
  };
}
