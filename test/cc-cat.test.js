const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  WIDTH, HEIGHT, LEFT_PADDING, TOP_PADDING, STATES, ANIMATIONS, PARTS, createParts,
  expressionPixels, compositeFrame, frameForState
} = require('../public/cc-cat');

const publicFile = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');
const coordinate = ({ x, y }) => `${x},${y}`;
const coordinates = pixels => new Set(pixels.map(coordinate));
const signature = pixels => pixels.map(({ x, y, color, w = 1, h = 1 }) => `${x},${y}:${color}:${w}x${h}`).sort().join(';');
const framesFor = state => Array.from({ length: ANIMATIONS[state].frames }, (_, index) =>
  frameForState(state, (index + 1e-6) / ANIMATIONS[state].frames));
const bounds = pixels => ({
  left: Math.min(...pixels.map(pixel => pixel.x)), right: Math.max(...pixels.map(pixel => pixel.x + (pixel.w ?? 1) - 1)),
  top: Math.min(...pixels.map(pixel => pixel.y)), bottom: Math.max(...pixels.map(pixel => pixel.y + (pixel.h ?? 1) - 1))
});

function assertConnected(pixels, name) {
  // Half-cell eyes and rear-paw edges render on the native doubled canvas.
  // Compare the actual covered subcells rather than treating every mark as 1x1.
  const remaining = new Set();
  for (const { x, y, w = 1, h = 1 } of pixels) {
    for (let dy = 0; dy < h * 2; dy++) for (let dx = 0; dx < w * 2; dx++) {
      remaining.add(`${x * 2 + dx},${y * 2 + dy}`);
    }
  }
  const pending = [remaining.values().next().value];
  assert.ok(pending[0], `${name} must contain pixels`);
  remaining.delete(pending[0]);
  while (pending.length) {
    const [x, y] = pending.pop().split(',').map(Number);
    // Pixel outlines legitimately meet at the corners of their stair steps.
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx || dy) {
        const key = `${x + dx},${y + dy}`;
        if (remaining.delete(key)) pending.push(key);
      }
    }
  }
  assert.equal(remaining.size, 0, `${name} has detached pixels: ${[...remaining].join(' ')}`);
}

test('the default cat is a low loaf with its haunch and short tail behind the head', () => {
  assert.equal(WIDTH, 28);
  assert.equal(HEIGHT, 18);
  assert.deepEqual(createParts(), PARTS);
  const cat = bounds(compositeFrame(PARTS));
  const head = bounds(PARTS.head), body = bounds(PARTS.body);
  const tail = bounds([...PARTS.tail, ...PARTS['tail-tip']]);
  assert.ok((cat.right - cat.left + 1) / (cat.bottom - cat.top + 1) >= 1.5, 'resting cat should read as a horizontal loaf');
  assert.ok(head.left < body.left && head.top < body.top, 'the head leads the low body');
  assert.ok(body.right > head.right, 'a rounded haunch remains visible behind the head');
  assert.ok(tail.right > body.right && tail.bottom <= body.bottom, 'tail extends sideways near the floor');
  assert.ok(tail.right - tail.left < 8 && tail.bottom - tail.top < 5, 'tail remains short');
  assert.equal(PARTS['foot-left'].length + PARTS['foot-right'].length, 0, 'the loaf tucks its legs beneath the body');
  for (const side of ['left', 'right']) {
    assert.ok(PARTS['paw-' + side].length > 0, 'tucked forepaws retain a visible hint');
    assert.ok(PARTS['paw-' + side].every(pixel => pixel.y >= body.bottom - 1), 'resting paws stay near the floor');
  }
});

test('all eight complete animation cycles stay on the pixel grid and inside the canvas', () => {
  assert.deepEqual(Object.keys(ANIMATIONS).sort(), [...STATES, 'walk'].sort());
  const supportedColors = new Set([...publicFile('cc-cat.css').matchAll(/\.cat-color-([a-z])\s*\{/g)].map(match => match[1]));
  let checked = 0;
  for (const [state, animation] of Object.entries(ANIMATIONS)) {
    assert.ok(animation.duration > 0 && Number.isInteger(animation.frames) && animation.frames >= 2);
    for (const [index, frame] of framesFor(state).entries()) {
      assert.equal(frame.index, index, `${state} skipped frame ${index}`);
      for (const [part, pixels] of Object.entries({ ...frame.parts, composite: frame.pixels })) {
        assert.equal(coordinates(pixels).size, pixels.length, `${state}/${index}/${part} repeats a pixel`);
        for (const { x, y, color, w = 1, h = 1 } of pixels) {
          const gridScale = ['composite', 'foot-left', 'foot-right'].includes(part) ? 2 : 1;
          assert.ok(Number.isInteger(x * gridScale) && x >= -LEFT_PADDING && x + w <= WIDTH, `${state}/${index}/${part}: invalid x ${x}`);
          const topPadding = ['head', 'tail-tip', 'composite'].includes(part) ? TOP_PADDING : 0;
          assert.ok(Number.isInteger(y) && y >= -topPadding && y + h <= HEIGHT, `${state}/${index}/${part}: invalid y ${y}`);
          assert.ok(w > 0 && w <= 1 && Number.isInteger(w * 2), `${state}/${index}/${part}: invalid width ${w}`);
          assert.ok(h > 0 && h <= 1 && Number.isInteger(h * 2), `${state}/${index}/${part}: invalid height ${h}`);
          assert.ok(supportedColors.has(color), `${state}/${index}/${part}: missing color swatch ${color}`);
        }
      }
      assertConnected(frame.pixels, `${state}/${index} complete silhouette`);
      checked++;
    }
  }
  assert.ok(checked >= 150, 'verify every frame, including short-lived poses');
});

test('half-cell paw edges preserve uncovered haunch color through later layers', () => {
  const bodyPixel = { x: 20, y: 15, color: 'f' };
  const narrowPaw = { x: 20, y: 15, color: 's', w: 0.5 };
  function compose(laterLayer = []) {
    return compositeFrame({ body: [bodyPixel], 'foot-right': [narrowPaw], head: laterLayer }, 'normal', { walk: true })
      .filter(pixel => pixel.y === 15 && pixel.x >= 20 && pixel.x < 21);
  }
  function renderedHalves(pixels) {
    return [20.25, 20.75].map(x => {
      let color;
      for (const pixel of pixels) if (pixel.x <= x && x < pixel.x + (pixel.w ?? 1)) color = pixel.color;
      return color;
    });
  }
  assert.deepEqual(renderedHalves(compose()), ['s', 'f'], 'a narrow paw must not erase the uncovered half of the haunch');
  const covered = compose([{ x: 20, y: 15, color: 'o' }]);
  assert.deepEqual(renderedHalves(covered), ['o', 'o'], 'a later full pixel covers both halves');
  assert.equal(covered.length, 1, 'a later full pixel removes the stale haunch fragment');
  assert.deepEqual(renderedHalves(compose([{ x: 20, y: 15, color: 'm', w: 0.5 }])), ['m', 'f'],
    'a later narrow paw keeps the previously uncovered haunch half');
});

test('faces remain attached to the head throughout every animation', () => {
  for (const state of Object.keys(ANIMATIONS)) for (const frame of framesFor(state)) {
    const head = coordinates(frame.parts.head);
    for (const expression of ['normal', 'curious', 'smile']) {
      const face = expressionPixels(expression, frame.pose);
      assert.ok(face.some(pixel => pixel.color === 'n'), `${state} loses its nose`);
      assert.ok(face.filter(pixel => pixel.color === 'e').length >= 2, `${state} loses its eyes`);
      for (const pixel of face) {
        assert.ok(Number.isInteger(pixel.x * 2) && Number.isInteger(pixel.y), 'expressions align with full or half grid cells');
        for (const x of [Math.floor(pixel.x), Math.ceil(pixel.x)]) {
          assert.ok(head.has(coordinate({ x, y: pixel.y })), `${state}/${frame.index}/${expression} paints outside the head at ${coordinate(pixel)}`);
        }
      }
    }
    assert.equal(signature(frame.pixels), signature(compositeFrame(frame.parts, frame.expression, frame.pose)), 'rendered frame and pose use the same face coordinates');
  }
});

test('the mouth stays centered between the eyes for smiling and glancing faces', () => {
  function assertCentered(face, label) {
    const mouth = face.find(pixel => pixel.color === 'n');
    const eyes = face.filter(pixel => pixel.color === 'e');
    assert.ok(mouth && eyes.length >= 2, `${label} keeps its eyes and mouth`);
    const eyeMiddle = (Math.min(...eyes.map(pixel => pixel.x)) + Math.max(...eyes.map(pixel => pixel.x))) / 2;
    assert.equal(mouth.x, eyeMiddle, `${label} mouth drifts away from the eye midpoint`);
  }
  for (const expression of ['normal', 'curious', 'smile', 'happy']) {
    for (const gaze of [-1, 0, 1]) {
      assertCentered(expressionPixels(expression, { gaze, headX: 1, headY: 1 }), `${expression}/gaze ${gaze}`);
    }
  }
  for (const state of Object.keys(ANIMATIONS)) for (const frame of framesFor(state)) {
    assertCentered(expressionPixels(frame.expression, frame.pose), `${state}/${frame.index}`);
  }
});

test('every action visibly animates and has its own sequence', () => {
  const sequences = new Set();
  for (const state of Object.keys(ANIMATIONS)) {
    const signatures = framesFor(state).map(frame => signature(frame.pixels));
    assert.ok(new Set(signatures).size >= 2, `${state} has no visible movement`);
    sequences.add([...new Set(signatures)].sort().join('|'));
  }
  assert.equal(sequences.size, Object.keys(ANIMATIONS).length, 'different actions must produce different poses');
  const thinking = framesFor('thinking');
  assert.ok(thinking.some(frame => frame.pose.blink) && thinking.some(frame => !frame.pose.blink), 'thinking blinks and reopens its eyes');
  assert.ok(new Set(thinking.map(frame => frame.pose.earDrop || 0)).size > 1, 'thinking moves an ear');
  assert.ok(thinking.every(frame => frame.pose.paw !== 'chin'), 'thinking no longer lifts a paw to the chin');
  assert.ok(framesFor('happy').some(frame => frame.pose.paw === 'wave'), 'happy includes a little paw greeting');
  assert.ok(framesFor('coding').every(frame => frame.parts.prop.length > 0), 'working keeps its laptop');
  assert.ok(framesFor('sweeping').every(frame => frame.parts.prop.length > 0), 'tidying keeps its broom');
  assert.ok(new Set(framesFor('looking').map(frame => frame.pose.gaze || 0)).size >= 3, 'looking glances both ways and returns to center');
});

test('typing paws tap above the laptop without showing through its front screen', () => {
  const work = framesFor('coding');
  for (const name of ['paw-left', 'paw-right']) {
    assert.ok(new Set(work.map(frame => signature(frame.parts[name]))).size > 1, `${name} keeps its typing motion`);
  }
  for (const frame of work) {
    const visible = new Map(frame.pixels.map(pixel => [coordinate(pixel), pixel.color]));
    for (const name of ['paw-left', 'paw-right']) {
      assert.ok(frame.parts[name].every(pixel => pixel.y <= 13), `${name} enters the front screen in frame ${frame.index}`);
    }
    const screen = frame.parts.prop.filter(pixel => pixel.y >= 14 && pixel.y <= 16);
    assert.ok(screen.length > 0, 'the laptop retains a front screen');
    for (const pixel of screen) {
      assert.equal(visible.get(coordinate(pixel)), pixel.color, `a paw or body pixel shows through the laptop at ${coordinate(pixel)} in frame ${frame.index}`);
    }
  }
});

test('walking keeps both short front paws visible as they alternate', () => {
  const idle = frameForState('idle');
  const walk = framesFor('walk');
  const idleBody = bounds(idle.parts.body);
  const ground = idleBody.bottom;
  const stepNames = ['paw-left', 'paw-right', 'foot-left', 'foot-right'];
  const rearLegs = [['foot-left', 17, 2.5, 's'], ['foot-right', 19, 2.5, 'f']];
  for (const frame of walk) {
    assert.ok(frame.pose.walk);
    assert.deepEqual(frame.parts.head, idle.parts.head, 'walking retains the approved head at its original height');
    const body = bounds(frame.parts.body);
    assert.equal(body.top, idleBody.top - 2, 'walking adds one row of height to the upper back');
    assert.equal(body.bottom, ground - 1, 'the lower body and cap remain fixed above the paws');
  }
  for (const part of stepNames) {
    const poses = walk.map(frame => frame.parts[part]);
    assert.ok(poses.every(pixels => pixels.length > 0), `${part} disappears while walking`);
    assert.ok(new Set(poses.map(signature)).size > 1, `${part} never steps`);
    assert.ok(poses.every(pixels => bounds(pixels).bottom - bounds(pixels).top <= 4), `${part} becomes a long upright leg`);
    assert.ok(poses.every(pixels => bounds(pixels).bottom <= ground), `${part} passes below the floor`);
    const soles = poses.map(pixels => {
      const floor = bounds(pixels).bottom;
      const toes = pixels.filter(pixel => pixel.y === floor);
      return { y: floor, x: (Math.min(...toes.map(pixel => pixel.x)) + Math.max(...toes.map(pixel => pixel.x))) / 2 };
    });
    assert.ok(Math.max(...soles.map(sole => sole.x)) > Math.min(...soles.map(sole => sole.x)), `${part} must move forward and back`);
    assert.ok(Math.max(...soles.map(sole => sole.y)) > Math.min(...soles.map(sole => sole.y)), `${part} must lift and land`);
  }
  for (const frame of walk) {
    const visible = new Map(frame.pixels.map(pixel => [coordinate(pixel), pixel.color]));
    const frontPaws = ['paw-left', 'paw-right'].map(part => {
      const pixels = frame.parts[part];
      const floor = bounds(pixels).bottom;
      const sole = pixels.filter(pixel => pixel.y === floor);
      const visibleSole = sole.filter(pixel => pixel.color === 'o' && visible.get(coordinate(pixel)) === 'o');
      const visibleFur = pixels.filter(pixel => pixel.y === floor - 1 && pixel.color === 'c' &&
        visible.get(coordinate(pixel)) === pixel.color);
      const visibleUpperFur = pixels.filter(pixel => pixel.y === floor - 2 && pixel.color === 'c' &&
        visible.get(coordinate(pixel)) === pixel.color);
      assert.equal(sole.length, 3, `walk/${frame.index}/${part} keeps its three-cell sole`);
      assert.equal(visibleSole.length, 3, `walk/${frame.index}/${part} needs all three dark sole cells visible even while lifted`);
      assert.ok(floor === ground || floor === ground - 1, `walk/${frame.index}/${part} restores its taller planted and lifted poses`);
      assert.ok(visibleFur.length >= 2, `walk/${frame.index}/${part} needs visible cream fur instead of disappearing behind the body`);
      assert.ok(visibleUpperFur.length >= 2, `walk/${frame.index}/${part} keeps its restored two-row fur height`);
      assert.ok(visibleSole.filter(pixel => visibleFur.some(fur => Math.abs(fur.x - pixel.x) <= 1 && fur.y === pixel.y - 1)).length >= 2,
        `walk/${frame.index}/${part} keeps its toe fur joined to its sole`);
      return { floor, left: Math.min(...sole.map(pixel => pixel.x)), right: Math.max(...sole.map(pixel => pixel.x)) };
    });
    assert.ok(frontPaws.some(paw => paw.floor === ground), `walk/${frame.index} needs a planted front paw at its restored height`);
    assert.ok(frontPaws[1].left > frontPaws[0].right, `walk/${frame.index} keeps two distinct front paws instead of one merged shape`);
    assert.ok(frame.parts['foot-right'].some(pixel => pixel.color === 'f' && visible.get(coordinate(pixel)) === 'f'),
      `walk/${frame.index} keeps the outer rear paw distinct from the shaded paw`);
    for (const [part, base, width, furColor] of rearLegs) {
      const pixels = frame.parts[part];
      const floor = bounds(pixels).bottom;
      const rowWidth = y => pixels.filter(pixel => pixel.y === y).reduce((sum, pixel) => sum + (pixel.w ?? 1), 0);
      assert.equal(bounds(pixels).top, 13, `walk/${frame.index}/${part} keeps its original attachment height`);
      assert.ok(pixels.every(pixel => Number.isInteger(pixel.x) && [0.5, 1].includes(pixel.w ?? 1) && (pixel.h ?? 1) === 1),
        `walk/${frame.index}/${part} uses exact full or half cells`);
      const root = pixels.filter(pixel => pixel.y === 13);
      assert.equal(Math.min(...root.map(pixel => pixel.x)), base, `walk/${frame.index}/${part} keeps its attachment beneath the haunch`);
      assert.equal(rowWidth(13), width, `walk/${frame.index}/${part} has a two-and-a-half-cell attachment`);
      assert.ok(root.some(pixel => pixel.w === 0.5), `walk/${frame.index}/${part} draws its half-cell endpoint explicitly`);
      assert.ok([13, 14].every(y => pixels.filter(pixel => pixel.y === y && pixel.color === furColor)
        .reduce((sum, pixel) => sum + (pixel.w ?? 1), 0) >= width),
        `walk/${frame.index}/${part} keeps both fur rows connected beneath the haunch`);
      if (part === 'foot-right') {
        const sole = pixels.filter(pixel => pixel.y === floor);
        assert.equal(rowWidth(floor), width, `walk/${frame.index}/${part} keeps its two-and-a-half-cell sole`);
        assert.ok(sole.some(pixel => pixel.w === 0.5), `walk/${frame.index}/${part} draws its sole's half-cell endpoint explicitly`);
        assert.ok(sole.every(pixel => pixel.color === 'o'), `walk/${frame.index}/${part} retains its dark lower outline`);
        assert.ok(floor === ground || floor === ground - 1, `walk/${frame.index}/${part} restores its taller planted and lifted poses`);
      } else {
        assert.ok(pixels.every(pixel => pixel.color === 's'), `walk/${frame.index}/${part} remains the shaded far leg`);
        assert.ok(floor === ground - 1 || floor === ground - 2, `walk/${frame.index}/${part} retains its tucked far-leg height`);
        if (floor === ground - 1) assert.equal(rowWidth(floor), width,
          `walk/${frame.index}/${part} keeps its planted toe two-and-a-half cells wide`);
      }
      assertConnected([...frame.parts.body, ...pixels], `walk/${frame.index}/${part} and haunch`);
    }
    assert.ok(bounds(frame.parts['foot-right']).right <= bounds(frame.parts.body).right,
      `walk/${frame.index} keeps the rear paw beneath the haunch`);
  }
  assert.ok(walk.some(frame => bounds(frame.parts['paw-left']).bottom > bounds(frame.parts['paw-right']).bottom), 'the right front paw lifts while the left supports the cat');
  assert.ok(walk.some(frame => bounds(frame.parts['paw-right']).bottom > bounds(frame.parts['paw-left']).bottom), 'the left front paw lifts while the right supports the cat');
  assert.ok(walk.some(frame => {
    const visible = new Map(frame.pixels.map(pixel => [coordinate(pixel), pixel.color]));
    return frame.parts['foot-left'].some(pixel => visible.get(coordinate(pixel)) === 's');
  }), 'the shaded far rear paw peeks out during its step');
  assert.ok(walk.some(frame => bounds(frame.parts['foot-left']).bottom + 1 > bounds(frame.parts['foot-right']).bottom), 'the outer rear paw lifts while the far paw supports the cat');
  assert.ok(walk.some(frame => bounds(frame.parts['foot-left']).bottom + 1 < bounds(frame.parts['foot-right']).bottom), 'the far rear paw lifts while the outer paw supports the cat');
});

test('blinks briefly close two plain eyes, then restore them, and happy eyes stay distinct', () => {
  const normal = expressionPixels('normal');
  const curious = expressionPixels('curious');
  const smile = expressionPixels('smile');
  assert.equal(new Set([normal, curious, smile].map(signature)).size, 3);
  for (const face of [normal, curious]) {
    const upper = face.filter(pixel => pixel.blink);
    assert.equal(upper.length, 2);
    assert.equal(new Set(upper.map(pixel => pixel.x)).size, 2);
    assert.ok(upper.every(pixel => face.some(lower => lower.color === 'e' && lower.x === pixel.x && lower.y === pixel.y + 1)), 'open eyes retain their lower pixel during a blink');
  }
  const idle = framesFor('idle');
  const blinking = idle.filter(frame => frame.pose.blink);
  assert.ok(blinking.length > 0 && blinking.length < idle.length / 4, 'blink occupies only a short part of the cycle');
  for (const frame of blinking) {
    const eyes = expressionPixels(frame.expression, frame.pose).filter(pixel => pixel.color === 'e');
    assert.equal(eyes.length, 2, 'both eyes close together to one-pixel lines');
    assert.equal(new Set(eyes.map(pixel => pixel.y)).size, 1);
  }
  assert.ok(!idle.at(-1).pose.blink && !idle[0].pose.blink, 'eyes reopen before the loop restarts');
  assert.ok(smile.every(pixel => !pixel.blink), 'smiling eyes do not inherit the open-eye blink');
});

test('cycles repeat at the same pose and reject nonfinite or unknown progress safely', () => {
  for (const state of Object.keys(ANIMATIONS)) {
    const first = frameForState(state, 0);
    for (const progress of [1, 2, -1, NaN, Infinity]) assert.deepEqual(frameForState(state, progress), first, `${state} does not loop consistently`);
    assert.equal(frameForState(state, 1 - 1e-8).index, ANIMATIONS[state].frames - 1);
    assert.equal(frameForState(state, -1e-8).index, ANIMATIONS[state].frames - 1);
  }
  assert.deepEqual(frameForState('unknown'), frameForState('idle'));
});

test('every selectable theme, including custom, owns a complete cat palette', () => {
  const select = publicFile('index.html').match(/<select\b[^>]*\bid=["']themeSelect["'][^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, 'theme selector is missing');
  const themes = [...select[1].matchAll(/<option\b[^>]*\bvalue=["']([^"']+)["']/g)].map(match => match[1]);
  assert.ok(themes.includes('custom'));
  assert.ok(themes.filter(theme => theme !== 'custom').length >= 24);
  assert.equal(new Set(themes).size, themes.length);
  const css = publicFile('cc-cat-themes.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const palettes = new Map();
  for (const [, selectors, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const [, theme] of selectors.matchAll(/\[data-theme=["']([^"']+)["']\]/g)) {
      const tokens = palettes.get(theme) || new Map();
      for (const [, property, value] of declarations.matchAll(/(--cat-[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(property, value.trim());
      palettes.set(theme, tokens);
    }
  }
  const requiredColors = [...new Set([...publicFile('cc-cat.css').matchAll(/\.cat-color-[a-z]\s*\{[^}]*background:\s*var\((--cat-[\w-]+)/g)].map(match => match[1]))];
  assert.ok(requiredColors.includes('--cat-fur') && requiredColors.includes('--cat-outline') && requiredColors.includes('--cat-eye'));
  for (const theme of themes) {
    const tokens = palettes.get(theme);
    assert.ok(tokens, `${theme} has no explicit cat palette`);
    assert.match(tokens.get('--cat-name') || '', /^"[^"\n]+"$/, `${theme} needs a cat name`);
    for (const token of requiredColors) assert.match(tokens.get(token) || '', /^(?:#[\da-f]{6}|color-mix\(.+\))$/i, `${theme} is missing a usable ${token}`);
    assert.notEqual(tokens.get('--cat-fur'), tokens.get('--cat-outline'), `${theme} hides the outline`);
    assert.notEqual(tokens.get('--cat-fur'), tokens.get('--cat-eye'), `${theme} hides the eyes`);
  }
});
