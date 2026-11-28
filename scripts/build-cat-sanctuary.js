#!/usr/bin/env node
'use strict';

// Build only the cat room. Never use public/ or the repository as a release root.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const projectRoot = fs.realpathSync(path.resolve(__dirname, '..'));
const sourceRoot = path.join(projectRoot, 'public');
const outputRoot = path.join(projectRoot, 'output');
const generator = 'memo-cat-sanctuary-static-site';
const baseFiles = [
  'cat-sanctuary.html',
  'cat-sanctuary.js',
  'cat-sanctuary-themes.css',
  'cat-sanctuary-themes.js',
  'cat-sanctuary-particles.css',
  'cat-sanctuary-particles.js',
  'theme-sync.js',
  'cc-cat.js',
  'cc-cat.css',
  'cc-cat-themes.css',
  'favicon.svg',
  'favicon.ico',
  'assets/cat-sanctuary/layout.js',
  'assets/cat-sanctuary/themes/catalog.js',
  'assets/cat-sanctuary/themes/outlines.js'
];

function fail(message) {
  throw new Error(message);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..' + path.sep)
    && relative !== '..' && !path.isAbsolute(relative);
}

function parseArguments() {
  const args = process.argv.slice(2);
  let out = path.join(outputRoot, 'cat-sanctuary-site');
  let supplied = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      console.log('Usage: node scripts/build-cat-sanctuary.js [--out output/cat-sanctuary-site]');
      return null;
    }
    if (supplied || argument !== '--out' && !argument.startsWith('--out=')) fail('Unknown or repeated argument. Use --out DIRECTORY.');
    const value = argument === '--out' ? args[++index] : argument.slice(6);
    if (!value || value.startsWith('--')) fail('--out requires a directory.');
    out = path.resolve(value);
    supplied = true;
  }
  return out;
}

function checkDestination(out) {
  // /tmp is a symlink to /private/tmp on macOS; only that root may be a symlink.
  const tempRoots = ['/tmp', '/private/tmp'].filter(root => fs.existsSync(root));
  const allowedRoot = [outputRoot, ...tempRoots].find(root => isInside(root, out));
  if (!allowedRoot) fail('Output must be a child directory of this project\'s output/ or /tmp/.');
  if (out === sourceRoot || isInside(sourceRoot, out) || isInside(out, sourceRoot)) fail('Output must not contain or overlap public/.');
  let current = allowedRoot;
  const components = path.relative(allowedRoot, out).split(path.sep);
  if (allowedRoot === outputRoot && fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('The output/ root must not be a symlink.');
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Output directory components must be real directories.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!fs.existsSync(out) || fs.readdirSync(out).length === 0) return;
  const manifestPath = path.join(out, 'manifest.json');
  try {
    if (fs.lstatSync(manifestPath).isSymbolicLink()) fail('Invalid previous build manifest.');
    const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (previous.generator !== generator || previous.manifestVersion !== 1) fail('Invalid previous build manifest.');
  } catch {
    fail('Refusing to clear a nonempty directory without this builder\'s manifest.json.');
  }
}

function cleanRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
      || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
      || value === '..' || value.startsWith('../')) fail('Unsafe source resource path.');
  const forbidden = /(?:^|\/)(?:\.git|\.ssh|\.aws|\.codex|\.agents|node_modules|storage|credentials?|secrets?)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)(?:\.deploy[^/]*|id_rsa[^/]*|id_ed25519[^/]*|authorized_keys|known_hosts)(?:\/|$)|\.(?:pem|key|pub|p12|pfx|crt|cer|der|sqlite|sqlite3|db)$/i;
  if (forbidden.test(value)) fail('Sensitive or nonpublic files are forbidden in a release.');
  return value;
}

function readSource(relative) {
  cleanRelative(relative);
  const source = path.join(sourceRoot, relative);
  const stat = fs.lstatSync(source);
  const real = fs.realpathSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || !isInside(sourceRoot, real)) fail('Source resource must be a regular file inside public/.');
  const content = fs.readFileSync(source);
  const text = content.toString('utf8');
  if (/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|PUBLIC KEY|CERTIFICATE)-----|(?:^|\n)\s*(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-\S+)\s+[A-Za-z0-9+/]{24,}/.test(text)) {
    fail('Key or certificate material is forbidden in a release.');
  }
  return content;
}

function loadTrustedData(relative, property) {
  const sandbox = {window:{}};
  vm.runInNewContext(readSource(relative).toString('utf8'), sandbox, {filename:relative, timeout:1000});
  const value = sandbox.window[property];
  if (!value || typeof value !== 'object') fail('Invalid local scene data.');
  return value;
}

function verifyReference(reference, from, whitelist) {
  const raw = reference.trim();
  if (!raw || raw.startsWith('#') || /^data:/i.test(raw)) return;
  // The page's assets must all be local. Fragment-only SVG masks are ignored.
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) fail('External asset references are not allowed in the static release.');
  let local;
  try { local = decodeURIComponent(raw.split(/[?#]/)[0]); }
  catch { fail('Malformed encoded resource path.'); }
  if (!local || local.startsWith('#')) return;
  if (local.startsWith('/') || local.includes('\\') || local.includes('\0')) fail('Asset paths must remain relative to the static site.');
  const resource = cleanRelative(path.posix.normalize(path.posix.join(path.posix.dirname(from), local)));
  if (!whitelist.has(resource)) fail('Referenced static resource is missing from the whitelist: ' + resource);
}

function verifyReferences(relative, content, whitelist) {
  const text = content.toString('utf8');
  if (/\.html$/i.test(relative)) {
    for (const match of text.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) verifyReference(match[2], relative, whitelist);
  }
  if (/\.(?:html|css)$/i.test(relative)) {
    for (const match of text.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi)) verifyReference(match[2] ?? match[3], relative, whitelist);
    for (const match of text.matchAll(/@import\s+(["'])(.*?)\1/gi)) verifyReference(match[2], relative, whitelist);
  }
}

function standaloneHtml(content) {
  let html = content.toString('utf8');
  if (!/<html\b/i.test(html)) fail('The cat room HTML root is missing.');
  html = html.replace(/<html\b([^>]*)>/i, (_tag, attributes) => {
    const clean = attributes.replace(/\s+data-room-settings(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
    return '<html' + clean + ' data-room-settings="local">';
  });
  return Buffer.from(html);
}

function build(out) {
  checkDestination(out);
  const catalog = loadTrustedData('assets/cat-sanctuary/themes/catalog.js', 'CatSanctuaryThemeCatalog');
  const layout = loadTrustedData('assets/cat-sanctuary/layout.js', 'CatRoomLayout');
  if (!Array.isArray(catalog.themes) || !catalog.themes.length) fail('Theme catalog is empty.');
  const images = catalog.themes.map(theme => {
    const image = cleanRelative(theme.image);
    if (!image.startsWith('assets/cat-sanctuary/') || !/\.png$/i.test(image)) fail('Theme image must be a PNG inside the cat-room assets.');
    return image;
  });
  if (new Set(images).size !== images.length) fail('Theme images must be unique.');
  const whitelist = new Set([...baseFiles, ...images]);
  if (!whitelist.has(cleanRelative(layout.image))) fail('The layout image is not in the theme whitelist.');

  // Validate the complete input set before creating or replacing any output.
  const inputs = [...whitelist].sort().map(relative => {
    const content = readSource(relative);
    verifyReferences(relative, content, whitelist);
    return {relative, content};
  });
  const html = standaloneHtml(inputs.find(input => input.relative === 'cat-sanctuary.html').content);
  const outputFiles = inputs.map(input => input.relative === 'cat-sanctuary.html' ? {...input, content:html} : input);
  outputFiles.push({relative:'index.html', content:html});
  outputFiles.sort((left, right) => left.relative.localeCompare(right.relative, 'en'));

  const parent = path.dirname(out);
  fs.mkdirSync(parent, {recursive:true});
  const staging = fs.mkdtempSync(path.join(parent, '.cat-sanctuary-build-'));
  let installed = false;
  try {
    const files = outputFiles.map(({relative, content}) => {
      const destination = path.join(staging, relative);
      fs.mkdirSync(path.dirname(destination), {recursive:true});
      fs.writeFileSync(destination, content, {flag:'wx'});
      return {path:relative, bytes:content.length, sha256:crypto.createHash('sha256').update(content).digest('hex')};
    });
    const manifest = {manifestVersion:1, generator, builtAt:new Date().toISOString(), themeCount:catalog.themes.length, files};
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag:'wx'});
    checkDestination(out);
    if (fs.existsSync(out)) fs.rmSync(out, {recursive:true});
    fs.renameSync(staging, out);
    installed = true;
    console.log('Built cat sanctuary: ' + out);
    console.log(files.length + ' assets; ' + catalog.themes.length + ' themes; manifest.json includes SHA-256 and byte sizes.');
  } finally {
    if (!installed) fs.rmSync(staging, {recursive:true, force:true});
  }
}

try {
  const out = parseArguments();
  if (out) build(out);
} catch (error) {
  console.error('Cat sanctuary build failed: ' + error.message);
  process.exitCode = 1;
}
