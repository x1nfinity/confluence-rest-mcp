import { extname } from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { ReadError } from './errors.js';
import { isOfficeAttachment, readOfficeAttachment, pageAttachmentText, type Warning } from './office.js';
const TEXT_TYPES: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.sql': 'application/sql', '.log': 'text/plain', '.yaml': 'application/yaml', '.yml': 'application/yaml'
};
const SAFE_MIMES: Record<string, string> = {
  'text/plain': 'text/plain', 'text/markdown': 'text/markdown', 'text/x-markdown': 'text/markdown', 'text/csv': 'text/csv', 'application/csv': 'text/csv', 'application/json': 'application/json', 'text/json': 'application/json', 'application/sql': 'application/sql', 'text/sql': 'application/sql', 'text/x-sql': 'application/sql', 'application/yaml': 'application/yaml', 'application/x-yaml': 'application/yaml', 'text/yaml': 'application/yaml', 'text/x-yaml': 'application/yaml'
};
const signatures = [
  Buffer.from('%PDF-'), Buffer.from('GIF87a'), Buffer.from('GIF89a'), Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('PK\x05\x06', 'latin1'), Buffer.from('PK\x07\x08', 'latin1'), Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10
  ]), Buffer.from([255, 216, 255]), Buffer.from('\x7fELF'), Buffer.from('RIFF'), Buffer.from('MZ')
];
const starts = (raw: Buffer, signature: Buffer) => raw.subarray(0, signature.length).equals(signature);
function types(name: unknown, mime: unknown) {
  const suffix = typeof name === 'string' ? extname(name).toLowerCase() : '', declared = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  return {
    suffixType: Object.hasOwn(TEXT_TYPES, suffix) ? TEXT_TYPES[suffix] : undefined,
    mimeType: Object.hasOwn(SAFE_MIMES, declared) ? SAFE_MIMES[declared] : undefined, declared
  };
}
export function isTextAttachment(name: unknown, mime: unknown) {
  const { suffixType, mimeType } = types(name, mime);
  return !!(suffixType || mimeType);
}
export function readTextAttachment(raw: Buffer, name: unknown, mime: unknown, textOffset = 0, maxTextChars = 12000) {
  if (!Number.isSafeInteger(textOffset) || textOffset < 0 || !Number.isSafeInteger(maxTextChars) || maxTextChars < 1 || maxTextChars > 30000)
    throw new ReadError('INVALID_ARGUMENT');
  const { suffixType, mimeType, declared } = types(name, mime);
  if (!suffixType && !mimeType)
    throw new ReadError('NOT_SUPPORTED');
  if (!Buffer.isBuffer(raw) || !raw.length)
    throw new ReadError('CONTENT_INCOMPLETE');
  if (raw.length > 4 * 1024 * 1024)
    throw new ReadError('RESPONSE_TOO_LARGE');
  if (signatures.some(signature => starts(raw, signature)))
    throw new ReadError('NOT_SUPPORTED');
  let encoding = 'utf-8', codec = 'utf-8';
  if (starts(raw, Buffer.from([239, 187, 191])))
    encoding = 'utf-8-sig';
  else if (starts(raw, Buffer.from([255, 254])))
    encoding = codec = 'utf-16-le';
  else if (starts(raw, Buffer.from([254, 255])))
    encoding = codec = 'utf-16-be';
  let text: string;
  try {
    text = new TextDecoder(codec.replace('utf-16-', 'utf-16'), { fatal: true }).decode(raw);
  }
  catch {
    throw new ReadError('NOT_SUPPORTED');
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text))
    throw new ReadError('NOT_SUPPORTED');
  const warnings: Warning[] = [];
  if (suffixType && declared && mimeType !== suffixType)
    warnings.push({ code: 'suffix_mime_mismatch', message: '文件后缀与声明 MIME 不一致；已严格校验文本编码，未验证或执行文件格式。' });
  return {
    ...pageAttachmentText(text, textOffset, maxTextChars), encoding, media_type: suffixType || mimeType, warnings
  };
}
function mediaType(raw: Buffer): string | undefined {
  if (starts(raw, Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10
  ])))
    return 'image/png';
  if (starts(raw, Buffer.from([255, 216, 255])))
    return 'image/jpeg';
  if (starts(raw, Buffer.from('GIF87a')) || starts(raw, Buffer.from('GIF89a')))
    return 'image/gif';
  if (starts(raw, Buffer.from('RIFF')) && raw.subarray(8, 12).equals(Buffer.from('WEBP')))
    return 'image/webp';
  if (starts(raw, Buffer.from('%PDF-')))
    return 'application/pdf';
  return undefined;
}
async function pdfText(raw: Buffer): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const child = spawn('pdftotext', [
      '-f', '1', '-l', '20', '-layout', '-enc', 'UTF-8', '-', '-'
    ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const decoder = new StringDecoder('utf8');
    let text = '', length = 0, finished = false, timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 15000);
    const finish = (result: Record<string, unknown>) => {
      if (finished)
        return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const append = (chunk: string) => {
      if (length >= 30000)
        return;
      const points = Array.from(chunk).slice(0, 30000 - length);
      length += points.length;
      text += points.join('');
    };
    child.stdout.on('data', (chunk: Buffer) => append(decoder.write(chunk)));
    child.on('error', (error: NodeJS.ErrnoException) => finish({ text_status: error.code === 'ENOENT' ? '未安装 pdftotext，请用客户端 PDF 阅读工具读取嵌入文件。' : '文字提取超时或不可用，请用客户端 PDF 阅读工具读取嵌入文件。' }));
    child.on('close', code => {
      if (code === 0 && !timedOut) {
        append(decoder.end());
        finish({ text, text_scope: '前 20 页的文字，最多 30000 字符；图表、扫描件及全文完整性未验证。' });
      }
      else
        finish({ text_status: timedOut ? '文字提取超时或不可用，请用客户端 PDF 阅读工具读取嵌入文件。' : '文字提取失败，请用客户端 PDF 阅读工具读取嵌入文件。' });
    });
    child.stdin.on('error', () => {
    });
    child.stdin.end(raw);
  });
}
/** The caller supplies freshly verified attachment metadata and a version-pinned download URL. */
export async function readAttachment(raw: Buffer, metadata: Record<string, unknown>, args: {
  text_offset?: number;
  max_text_chars?: number;
} = {}): Promise<Record<string, unknown>> {
  if (!Buffer.isBuffer(raw) || !raw.length)
    throw new ReadError('CONTENT_INCOMPLETE');
  if (raw.length > 4 * 1024 * 1024)
    throw new ReadError('RESPONSE_TOO_LARGE');
  const offset = args.text_offset ?? 0, max = args.max_text_chars ?? 12000, mime = mediaType(raw);
  let extracted: Record<string, unknown>;
  if (!mime) {
    if (isOfficeAttachment(metadata.name, metadata.media_type))
      extracted = readOfficeAttachment(raw, metadata.name, metadata.media_type, offset, max);
    else if (isTextAttachment(metadata.name, metadata.media_type))
      extracted = readTextAttachment(raw, metadata.name, metadata.media_type, offset, max);
    else
      throw new ReadError('NOT_SUPPORTED');
  }
  else {
    if (offset !== 0 || max !== 12000)
      throw new ReadError('INVALID_ARGUMENT');
    const encoded = raw.toString('base64');
    if (mime.startsWith('image/'))
      extracted = { media_type: mime, _content: [{
            type: 'image', data: encoded, mimeType: mime
          }] };
    else {
      if (typeof metadata.download_url !== 'string' || !metadata.download_url)
        throw new ReadError('CONTENT_INCOMPLETE');
      const text = await pdfText(raw);
      const warnings: Warning[] = [{ code: 'pdf_scope_limited', message: 'PDF 文字最多前 20 页及 30000 字符；图表、扫描件和视觉全文未验证。' }];
      if (text.text_status)
        warnings.push({ code: 'pdf_text_unavailable', message: String(text.text_status) });
      extracted = {
        media_type: mime, _content: [{ type: 'resource', resource: {
              uri: metadata.download_url, mimeType: mime, blob: encoded
            } }], ...text, warnings
      };
    }
  }
  return {
    ...metadata, ...extracted, content_read: true, downloaded_bytes: raw.length
  };
}
