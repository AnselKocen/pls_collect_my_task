const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { readMaterial, MAX_FILE_BYTES, MAX_TEXT_CHARS } = require('../tasks/habit-material');
const { docx, pdf } = require('./habit-material-fixtures');

const original = '每日读一页书，记录一项观察，整理桌面。';
const file = (name, buffer) => ({ originalname: name, buffer, size: buffer.length });

test('material extraction reads real TXT, ZIP, DOC, DOCX and Chinese PDF content', async () => {
  const zip = new AdmZip();
  zip.addFile('skills/observations.md', Buffer.from(original));
  zip.addFile('__MACOSX/._ignore', Buffer.from('不应出现'));
  zip.addFile('assets/logo.png', Buffer.from([0, 1, 2]));
  const samples = [
    ['观察🌿.TXT', Buffer.from(original)],
    ['utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(original, 'utf16le')])],
    ['gbk.txt', Buffer.from([0xd5, 0xfb, 0xc0, 0xed, 0xd7, 0xc0, 0xc3, 0xe6])],
    ['skills.zip', zip.toBuffer()],
    ['observations.doc', fs.readFileSync(path.join(__dirname, 'fixtures/habit-material/observations.doc'))],
    ['observations.docx', docx()],
    ['observations.pdf', pdf()]
  ];
  for (const [name, buffer] of samples) {
    const result = await readMaterial({ file: file(name, buffer) });
    assert.ok(result.text.includes(name === 'gbk.txt' || name.endsWith('.pdf') ? '整理桌面' : original), name + ': ' + result.text);
    assert.doesNotMatch(result.text, /不应出现/);
    assert.equal(result.sourceName, name);
    assert.equal(result.truncated, false);
  }
  const mixed = new AdmZip();mixed.addFile('notes.docx', docx());mixed.addFile('notes.pdf', pdf());
  assert.match((await readMaterial({ file: file('mixed.zip', mixed.toBuffer()) })).text, /Observe the light/);
});

test('pasted material preserves text and file extraction has a bounded model input', async () => {
  const result = await readMaterial({ text: '\uFEFF  我的近期计划：每天散步。\r\n记录沿途发现。  ' });
  assert.equal(result.text, '我的近期计划：每天散步。\n记录沿途发现。');
  assert.equal(result.sourceName, '粘贴文字');
  const long = await readMaterial({ file: file('long.txt', Buffer.from('观察。'.repeat(MAX_TEXT_CHARS))) });
  assert.equal(long.text.length, MAX_TEXT_CHARS);assert.equal(long.truncated, true);
});

test('invalid, blank, oversized and unsafe materials fail before model invocation', async () => {
  const rejects = (input, pattern) => assert.rejects(readMaterial(input), pattern);
  await rejects({}, /上传素材|粘贴/);
  await rejects({ text: '  \r\n\t' }, /上传素材|粘贴/);
  await rejects({ text: '字'.repeat(MAX_TEXT_CHARS + 1) }, /20万字/);
  await rejects({ file: { originalname: 'huge.txt', size: MAX_FILE_BYTES + 1 } }, /20MB/);
  await rejects({ file: file('image.png', Buffer.from('image')) }, /支持 TXT/);
  await rejects({ file: file('empty.txt', Buffer.alloc(0)) }, /为空/);
  await rejects({ file: file('binary.txt', Buffer.alloc(50)) }, /可读/);
  await rejects({ file: file('empty.txt', Buffer.from('\n\t ')) }, /没有可读/);
  await rejects({ file: file('broken.zip', Buffer.from('not a ZIP')) }, /ZIP文件损坏/);
  await rejects({ file: file('empty.zip', new AdmZip().toBuffer()) }, /ZIP中没有找到可读的文本文件/);
  await rejects({ file: file('broken.docx', Buffer.from('not a Word file')) }, /Word文件损坏/);
  await rejects({ file: file('broken.doc', Buffer.alloc(512)) }, /Word文件无法读取/);
  await rejects({ file: file('broken.pdf', Buffer.from('%PDF-1.7\nnot a valid PDF')) }, /PDF文件无法读取/);
  await rejects({ file: file('scan.pdf', pdf('')) }, /扫描件|没有可提取的文字/);
  await rejects({ file: file('notes.txt', Buffer.from('notes')), text: 'other' }, /一次提交一个/);
  const archive = new AdmZip();archive.addFile('xx/unsafe.txt', Buffer.from('unsafe'));
  const unsafe = Buffer.from(archive.toBuffer().toString('latin1').replaceAll('xx/unsafe.txt', '../unsafe.txt'), 'latin1');
  await rejects({ file: file('unsafe.zip', unsafe) }, /不支持的文件路径/);
  const large = new AdmZip();large.addFile('too-big.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 'a'));
  await rejects({ file: file('bomb.zip', large.toBuffer()) }, /解压内容过大/);
});
