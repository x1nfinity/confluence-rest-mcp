import { Parser, Tokenizer } from 'htmlparser2';
import { ReadError } from './errors.js';

const BLOCKS = new Set('p div h1 h2 h3 h4 h5 h6 ul ol table pre blockquote hr dl'.split(' '));
const TAGS = new Set([...BLOCKS, ...'li thead tbody tfoot tr th td caption colgroup col span strong b em i u s strike del code a br img dt dd sub sup'.split(' ')]);
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
export const MAX_BODY_BYTES = 1024 * 1024;
function unsupported(): never { throw new ReadError('NOT_SUPPORTED'); }
export function validUtf8(value: string) { return !/\p{Surrogate}/u.test(value); }

// Token positions retain the source; a separate stack prevents HTML error recovery.
function blocks(source: string, restricted = false) {
  const stack: string[] = [], result: { tag: string; start: number; end: number }[] = [];
  let blockStart = 0, tag = '', tagStart = 0, pendingTag = false;
  const attribute = (attr: string, value: string) => {
    if (attr.startsWith('on') || ['srcdoc', 'srcset'].includes(attr)) unsupported();
    if (['href', 'src', 'background'].includes(attr) && value) {
      // urlsplit removes ASCII tabs and newlines before parsing a scheme.
      const link = value.replace(/[\t\r\n]/gu, '').replace(/^[\x00-\x20]+/u, '');
      const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(link)?.[1].toLowerCase();
      if (scheme && !['http', 'https', 'mailto'].includes(scheme)) unsupported();
      try { if (/^(?:https?:)?\/\//iu.test(link)) new URL(link, 'https://example.com'); }
      catch { unsupported(); }
    }
    if (attr === 'style' && /url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding|\\/iu.test(value)) unsupported();
  };
  const open = (end: number, selfclosing = false) => {
    pendingTag = false;
    if (restricted && (!TAGS.has(tag) || !stack.length && !BLOCKS.has(tag))) unsupported();
    if (restricted) new Parser({ onattribute: attribute }, { decodeEntities: true })
      .end(source.slice(tagStart, end + 1));
    if (!stack.length) blockStart = tagStart;
    if (VOID.has(tag) || selfclosing) {
      if (!stack.length) result.push({ tag, start: blockStart, end: end + 1 });
    } else stack.push(tag);
  };
  const tokenizer = new Tokenizer({ xmlMode: true, decodeEntities: false, recognizeSelfClosing: true }, {
    onopentagname(start, end) { tag = source.slice(start, end).toLowerCase(); tagStart = start - 1; pendingTag = true; },
    onopentagend(end) { open(end); },
    onselfclosingtag(end) { open(end, true); },
    onattribname() {}, onattribdata() {}, onattribentity() {}, onattribend() {},
    onclosetag(start, end) {
      const name = source.slice(start, end).split(/\s/u)[0].toLowerCase();
      const closeStart = source.lastIndexOf('</', start), closeEnd = source.indexOf('>', end) + 1;
      if (stack.at(-1) !== name || !closeEnd
        || restricted && !new RegExp('^</\\s*' + name + '\\s*>$', 'iu').test(source.slice(closeStart, closeEnd))) unsupported();
      stack.pop();
      if (!stack.length) result.push({ tag: name, start: blockStart, end: closeEnd });
    },
    ontext(start, end) {
      const text = source.slice(start, end);
      if (source.slice(Math.max(0, start - 2), start) === '<?'
        || !stack.length && (restricted && text.trim() || text.includes('<'))) unsupported();
    },
    ontextentity() { if (restricted && !stack.length) unsupported(); },
    oncomment(_start, end) { if (end >= source.length) unsupported(); },
    oncdata(_start, end) { if (restricted || end >= source.length) unsupported(); },
    ondeclaration(_start, end) { if (restricted || end >= source.length) unsupported(); },
    onprocessinginstruction(_start, end) { if (restricted || end >= source.length) unsupported(); },
    onend() {},
  });
  // HTML processing instructions close at >; retain offsets in XML tokenization.
  tokenizer.write(source.replace(/<\?([^>]*>)/gu, '<!$1').replace(/<(?=[^A-Za-z!?/])/gu, ' ')); tokenizer.end();
  if (stack.length || pendingTag) unsupported();
  return result;
}

export function patchStorage(old: string, operation: string, body: string, fragment?: string | null) {
  if (typeof old !== 'string' || !['append', 'replace'].includes(operation)
    || typeof body !== 'string' || !body.trim()
    || operation === 'append' && fragment != null
    || operation === 'replace' && (typeof fragment !== 'string' || !fragment.trim())
    || !validUtf8(old) || !validUtf8(body) || typeof fragment === 'string' && !validUtf8(fragment))
    throw new ReadError('INVALID_ARGUMENT');
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new ReadError('RESPONSE_TOO_LARGE');
  if (!blocks(body, true).length) unsupported();
  const oldBlocks = blocks(old);
  let result = old + body;
  if (operation === 'replace') {
    const target = fragment as string, parsed = blocks(target, true);
    if (parsed.length !== 1 || parsed[0].start !== 0 || parsed[0].end !== target.length) unsupported();
    const matches = oldBlocks.filter(block => BLOCKS.has(block.tag) && old.slice(block.start, block.end) === target);
    if (matches.length !== 1) throw new ReadError('TARGET_AMBIGUOUS');
    result = old.slice(0, matches[0].start) + body + old.slice(matches[0].end);
  }
  if (Buffer.byteLength(result) > MAX_BODY_BYTES) throw new ReadError('RESPONSE_TOO_LARGE');
  return result;
}
