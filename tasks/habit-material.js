const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2000;
const MAX_PDF_PAGES = 1500;
const FILE_EXTENSIONS = new Set(['.txt', '.zip', '.doc', '.docx', '.pdf']);
const ZIP_TEXT_EXTENSIONS = new Set(['', '.txt', '.md', '.html', '.htm', '.csv', '.json', '.xml']);

class MaterialError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'MaterialError'; this.status = status; }
}

function cleanText(value) {
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
}

function decodeText(buffer) {
  let text;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) text = new TextDecoder('utf-16le').decode(buffer);
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) text = new TextDecoder('utf-16be').decode(buffer);
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { text = new TextDecoder('gb18030').decode(buffer); }
  }
  const controls = text.match(/[\u0000-\u0008\u000B\u000E-\u001F]/g)?.length || 0;
  if (controls > Math.max(1, text.length / 100)) throw new MaterialError('素材不是可读的文本文件，请检查文件内容');
  return cleanText(text);
}

function openArchive(buffer, label = 'ZIP') {
  let zip, entries;
  try { zip = new AdmZip(buffer); entries = zip.getEntries(); }
  catch { throw new MaterialError(`${label}文件损坏或格式不正确，请重新上传`); }
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new MaterialError(`${label}文件条目过多，请精简后上传`, 413);
  let total = 0;
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..') || name.length > 1024 || ((entry.attr >>> 16) & 0xf000) === 0xa000) {
      throw new MaterialError(`${label}包含不支持的文件路径或链接，请重新打包`);
    }
    total += entry.header.size;
    if (!Number.isSafeInteger(total) || total > MAX_ARCHIVE_BYTES || entry.header.size > MAX_FILE_BYTES) {
      throw new MaterialError(`${label}解压内容过大，请精简后上传`, 413);
    }
  }
  return entries;
}

async function wordText(buffer, extension) {
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (extension === '.docx' && !isZip) throw new MaterialError('Word文件损坏或格式不正确，请重新上传');
  if (isZip) {
    const entries = openArchive(buffer, 'Word');
    if (!entries.some(entry => entry.entryName === 'word/document.xml')) throw new MaterialError('Word文件中没有找到文档正文');
  }
  try {
    const WordExtractor = require('word-extractor');
    const document = await new WordExtractor().extract(buffer);
    return cleanText([document.getBody(), document.getTextboxes({ includeHeadersAndFooters: false })].filter(Boolean).join('\n'));
  } catch (error) {
    if (error instanceof MaterialError) throw error;
    throw new MaterialError('Word文件无法读取，请检查是否损坏或加密后重新上传');
  }
}

async function pdfText(buffer) {
  if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new MaterialError('PDF文件损坏或格式不正确，请重新上传');
  let pdf;
  try {
    const { getDocumentProxy } = require('unpdf');
    pdf = await getDocumentProxy(new Uint8Array(buffer), { isEvalSupported: false, maxImageSize: 1, verbosity: 0, stopAtErrors: true });
    if (pdf.numPages > MAX_PDF_PAGES) throw new MaterialError('PDF页数过多，请拆分后上传', 413);
    let content = '';
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const { items } = await page.getTextContent();
        content += items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('') + '\n';
      } finally { page.cleanup(); }
      if (content.length > MAX_TEXT_CHARS) break;
    }
    return cleanText(content);
  } catch (error) {
    if (error instanceof MaterialError) throw error;
    if (/password|encrypted/i.test(error.name + ' ' + error.message)) throw new MaterialError('PDF已加密，请解除密码后上传');
    throw new MaterialError('PDF文件无法读取，请检查文件是否损坏后重新上传');
  } finally { if (pdf) await pdf.destroy(); }
}

async function fileText(buffer, filename, allowZip = true) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.doc' || extension === '.docx') return wordText(buffer, extension);
  if (extension === '.pdf') return pdfText(buffer);
  if (extension === '.zip' && allowZip) {
    const entries = openArchive(buffer).sort((a, b) => a.entryName.localeCompare(b.entryName));
    let content = '';
    for (const entry of entries) {
      if (entry.isDirectory || entry.entryName.split('/').some(part => part.startsWith('.') || part === '__MACOSX')) continue;
      const ext = path.extname(entry.entryName).toLowerCase();
      if (!ZIP_TEXT_EXTENSIONS.has(ext) && !['.doc', '.docx', '.pdf'].includes(ext)) continue;
      let text;
      try { text = await fileText(entry.getData(), entry.entryName, false); }
      catch (error) {
        if (error instanceof MaterialError) throw error;
        throw new MaterialError('ZIP中的文件无法读取，请检查压缩包是否损坏');
      }
      if (text) content += `\n--- ${entry.entryName} ---\n${text}\n`;
      if (content.length > MAX_TEXT_CHARS) break;
    }
    if (!content.trim()) throw new MaterialError('ZIP中没有找到可读的文本文件，请放入文字、Word或PDF素材');
    return content.trim();
  }
  return decodeText(buffer);
}

async function readMaterial({ file, text, sourceName } = {}) {
  if (file && text !== undefined && String(text).trim()) throw new MaterialError('请一次提交一个文件或一段文字');
  if (!file) {
    if (typeof text !== 'string' || !cleanText(text)) throw new MaterialError('请上传素材文件或粘贴一段文字');
    if (text.length > MAX_TEXT_CHARS) throw new MaterialError('粘贴文字不能超过20万字，请精简后重试', 413);
    return { text: cleanText(text), sourceName: typeof sourceName === 'string' && sourceName.trim() ? sourceName.trim().slice(0, 240) : '粘贴文字', sourceType: 'text', truncated: false };
  }
  const name = path.basename(String(file.originalname).replace(/\\/g, '/'));
  if (!FILE_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new MaterialError('支持 TXT、ZIP、Word（DOC/DOCX）和 PDF 文件');
  if (!file.size || file.size > MAX_FILE_BYTES) throw new MaterialError(file.size ? '素材文件不能超过20MB，请精简后上传' : '素材文件为空，请重新选择', file.size ? 413 : 400);
  const buffer = file.buffer || await fs.readFile(file.path);
  if (buffer.length > MAX_FILE_BYTES) throw new MaterialError('素材文件不能超过20MB，请精简后上传', 413);
  const content = cleanText(await fileText(buffer, name));
  if (!content) throw new MaterialError(path.extname(name).toLowerCase() === '.pdf' ? 'PDF中没有可提取的文字；扫描件请先识别文字，或粘贴文字后生成' : '素材中没有可读的文字，请检查后重新上传');
  const truncated = content.length > MAX_TEXT_CHARS;
  return { text: content.slice(0, MAX_TEXT_CHARS), sourceName: name, sourceType: 'material', truncated };
}

module.exports = { readMaterial, MaterialError, MAX_FILE_BYTES, MAX_TEXT_CHARS };
