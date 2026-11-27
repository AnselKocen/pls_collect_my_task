const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ANIMATIONS, PARTS, LEFT_PADDING, TOP_PADDING, frameForState, frameForIdleAction, expressionPixels
} = require('../public/cc-cat');

const signature = pixels => pixels.map(({ x, y, color, w = 1 }) => `${x},${y}:${color}:${w}`).sort().join(';');
const framesFor = state => Array.from({ length: ANIMATIONS[state].frames }, (_, index) =>
  frameForState(state, (index + 1e-6) / ANIMATIONS[state].frames));
const bounds = pixels => ({
  left: Math.min(...pixels.map(pixel => pixel.x)),
  right: Math.max(...pixels.map(pixel => pixel.x + (pixel.w ?? 1) - 1)),
  top: Math.min(...pixels.map(pixel => pixel.y)),
  bottom: Math.max(...pixels.map(pixel => pixel.y))
});
const visible = (frame, pixel) => frame.pixels.some(mark =>
  mark.x === pixel.x && mark.y === pixel.y && mark.color === pixel.color);

test('standing and stretching preserve the approved head through translation alone', () => {
  for (const state of ['stand', 'stretch']) for (const frame of framesFor(state)) {
    assert.equal(frame.expression, 'gentle', `${state} keeps its accepted two-cell diagonal eyes and small square nose`);
    const baseHead = frame.parts.head.map(pixel => ({
      ...pixel, x: pixel.x - (frame.pose.headX || 0), y: pixel.y - (frame.pose.headY || 0)
    }));
    assert.equal(signature(baseHead), signature(PARTS.head), 'standing must not reshape, scale or recolor the approved head');
    if (state === 'stretch') assert.equal(frame.headPixelSize, 5, 'the independent head keeps the original idle cell size without enlarging the body');
    const canvas = frame.viewport;
    assert.ok(canvas && canvas.width > 29 && canvas.height > 22, 'standing gets enough canvas space for its body and curled tail');
    const outline = bounds(frame.pixels);
    assert.ok(outline.right + 1 <= canvas.width - canvas.left && outline.bottom + 1 <= canvas.height - canvas.top,
      'the standing silhouette remains wholly inside its viewport');
  }
});

test('reference standing body, four legs and curled tail stay fixed throughout the cycle', () => {
  const frames = framesFor('stand'), rest = frames[0];
  for (const frame of frames) for (const part of Object.keys(rest.parts)) {
    assert.equal(signature(frame.parts[part]), signature(rest.parts[part]), `${part} changes the preserved standing artwork`);
  }
  const legNames = ['paw-left', 'paw-right', 'foot-left', 'foot-right'];
  const legs = legNames.map(part => ({ part, ...bounds(rest.parts[part]) }));
  for (const leg of legs) {
    assert.ok(rest.parts[leg.part].length > 0, `${leg.part} disappears from the four-legged standing pose`);
    const visibleLeg = rest.parts[leg.part].filter(pixel => visible(rest, pixel));
    assert.ok(visibleLeg.some(pixel => pixel.y === leg.bottom), `${leg.part} retains its visible planted foot`);
    assert.ok(leg.bottom > bounds(rest.parts.head).bottom, `${leg.part} extends down below the head`);
  }
  for (let index = 1; index < legs.length; index++) {
    const previous = bounds(rest.parts[legs[index - 1].part].filter(pixel => pixel.y === legs[index - 1].bottom));
    const current = bounds(rest.parts[legs[index].part].filter(pixel => pixel.y === legs[index].bottom));
    assert.ok(previous.right < current.left, 'four reference feet retain their separate horizontal positions even where leg roots touch');
  }
  const tail = [...rest.parts.tail, ...rest.parts['tail-tip']];
  assert.ok(tail.length > 0 && bounds(tail).top < bounds(rest.parts.body).top, 'the unchanged curled tail rises above the back');
});

test('standing proportions keep the short torso, lower back and shorter legs at a fixed pixel scale', () => {
  const frame = frameForState('stand');
  // The accepted standing reference had a 24-cell torso, eight-cell lower legs,
  // and a nine-cell-wide tail curl ending at x=32. Keep its head and drawing
  // scale fixed while shortening the torso by three columns, lowering its back
  // by two rows and shortening the exposed lower legs to three rows.
  const body = bounds(frame.parts.body), tail = bounds(frame.parts['tail-tip']);
  assert.equal(body.right - body.left + 1, 24 - 3, 'the torso loses exactly three horizontal pixel columns');
  assert.deepEqual({left:body.left, top:body.top, bottom:body.bottom}, {left:3, top:5, bottom:17},
    'the torso keeps its shoulder position while the back moves down two rows');
  for (const part of ['paw-left', 'paw-right', 'foot-left', 'foot-right']) {
    const leg = bounds(frame.parts[part]);
    assert.equal(leg.top, 18, `${part} keeps its original attachment height`);
    assert.equal(leg.bottom - leg.top + 1, 3, `${part} keeps only three exposed lower-leg rows`);
    assert.equal(leg.bottom, 20, `${part} foot moves up by another two rows`);
  }
  for (const [part, left, width] of [['foot-left',15,3.8], ['foot-right',19,2.8]]) {
    const leg = bounds(frame.parts[part]);
    assert.equal(leg.left, left, `${part} keeps its accepted left edge`);
    assert.ok(Math.abs(leg.right - leg.left + 1 - width) < 1e-9, `${part} narrows by exactly 0.2 of a cell`);
    const rightOutline = frame.parts[part].filter(pixel => pixel.color === 'o' && Math.abs(pixel.x + (pixel.w ?? 1) - (left + width)) < 1e-9);
    assert.ok(rightOutline.length > 0 && rightOutline.every(pixel => (pixel.w ?? 1) === 1), `${part} retains its full-cell right outline`);
  }
  assert.equal(frame.viewport.rasterScale, 10, 'the precise paw widths render on a tenth-cell raster');
  assert.deepEqual(tail, {left:21, right:29, top:2, bottom:9}, 'the intact tail curl follows the lowered back without being squashed');
  for (const state of ['stand', 'stretch']) for (const current of framesFor(state)) {
    const mouth = expressionPixels(current.expression, current.pose).find(pixel => pixel.color === 'n');
    const chestY = mouth.y + 6;
    for (const [x, y] of [[mouth.x-1,chestY], [mouth.x,chestY], [mouth.x+1,chestY], [mouth.x,chestY+1]]) {
      const crease = current.parts.body.find(pixel => pixel.x === x && pixel.y === y && pixel.color === 's');
      assert.ok(crease && visible(current, crease), `${state}/${current.index} chest T stays visible and centered below the mouth at ${x},${y}`);
    }
  }
  assert.deepEqual({width:frame.viewport.width, height:frame.viewport.height, left:frame.viewport.left, top:frame.viewport.top},
    {width:33, height:26, left:0, top:0}, 'the viewport retains the accepted pixel scale instead of magnifying the shorter cat');
  assert.equal(frame.viewport.baseline, 21, 'the rendered ground baseline follows the shortened feet');
});

test('standing coat and outline share the cat theme palette instead of the fixed white reference colors', () => {
  const themeColors = new Set('fopdenbsmct');
  for (const frame of framesFor('stand')) {
    for (const [part, pixels] of Object.entries(frame.parts)) for (const pixel of pixels) {
      assert.ok(themeColors.has(pixel.color), `${part} retains a fixed reference color ${pixel.color}`);
    }
    for (const color of ['f', 'o']) {
      assert.ok(frame.parts.body.some(pixel => pixel.color === color && visible(frame, pixel)),
        `the body needs visible theme ${color === 'f' ? 'fur' : 'outline'} pixels to match the head`);
    }
  }
});

test('the gentle face keeps its two-cell diagonal eyes and blush through a brief standing blink', () => {
  const frames = framesFor('stand'), rest = frames[0];
  const faces = frames.map(frame => expressionPixels(frame.expression, frame.pose));
  const faceCoordinates = new Set(faces.flat().map(pixel => `${pixel.x},${pixel.y}`));
  const outsideFace = frame => frame.pixels.filter(pixel => !faceCoordinates.has(`${pixel.x},${pixel.y}`));
  const baseline = signature(outsideFace(rest));
  for (const frame of frames) assert.equal(signature(outsideFace(frame)), baseline, 'a standing blink moves pixels outside the face');
  const eyeCount = face => face.filter(pixel => pixel.color === 'e').length;
  const openCount = Math.max(...faces.map(eyeCount));
  const closedFrames = faces.filter(face => eyeCount(face) < openCount);
  assert.ok(closedFrames.length > 0 && closedFrames.length < frames.length / 4, 'the blink lasts for a small part of the standing cycle');
  assert.equal(eyeCount(faces[0]), openCount, 'standing starts with open eyes');
  assert.equal(signature(rest.pixels), signature(frames.at(-1).pixels), 'standing reopens its eyes before the loop boundary');
  for (const state of ['stand', 'stretch']) for (const frame of framesFor(state)) {
    if (frame.expression !== 'gentle') continue;
    const face = expressionPixels(frame.expression, frame.pose), nose = face.find(pixel => pixel.color === 'n');
    const eyes = face.filter(pixel => pixel.color === 'e');
    assert.equal((Math.min(...eyes.map(pixel => pixel.x)) + Math.max(...eyes.map(pixel => pixel.x))) / 2, nose.x,
      'the diagonal eyes and square nose keep the same centerline');
    assert.equal(face.filter(pixel => pixel.color === 'n').length, 1, 'the nose stays a single square cell');
    assert.ok(!face.some(pixel => pixel.color === 'o'), 'the gentle face has no extra mouth fork or vertical stem');
    const blush = face.filter(pixel => pixel.color === 'b');
    assert.ok(blush.some(pixel => pixel.x < nose.x) && blush.some(pixel => pixel.x > nose.x) && blush.every(pixel => visible(frame, pixel)),
      'soft blush stays visible on both cheeks');
    if (!frame.pose.blink) for (const side of [-1, 1]) {
      const eye = eyes.filter(pixel => side * (pixel.x - nose.x) > 0);
      assert.equal(eye.length, 2, 'each open eye consists of exactly two cells');
      const [upper, lower] = [...eye].sort((first, second) => first.y - second.y);
      assert.equal(lower.y, upper.y + 1, 'the second eye cell sits one row lower');
      assert.equal(lower.x, upper.x - side, 'the lower eye cell sits one column nearer the nose');
      assert.ok(eye.every(pixel => visible(frame, pixel)), 'the diagonal eye shape remains visible on the head');
    }
  }
});

test('redrawn leisure actions finish at their starting pose without a loop seam', () => {
  for (const state of ['stretch', 'yarn', 'belly']) {
    const frames = framesFor(state);
    assert.equal(signature(frames[0].pixels), signature(frames.at(-1).pixels), `${state} jumps at the loop boundary`);
    const visiblePoses = new Set(frames.map(frame => signature(frame.pixels))).size;
    if (state === 'belly') assert.equal(visiblePoses, 1, 'the sleeping cat stays visibly still with its closed eyes');
    else assert.ok(visiblePoses >= 4, `${state} needs a complete visible movement`);
  }
});

test('watching the ball and sleeping retain the approved full-size loaf and head', () => {
  for (const state of ['yarn', 'belly']) for (const frame of framesFor(state)) {
    const head = frame.parts.head.map(pixel => ({...pixel,
      x:pixel.x - (frame.pose.headX || 0), y:pixel.y - (frame.pose.headY || 0)
    }));
    assert.equal(signature(head), signature(PARTS.head), `${state} preserves the approved head through translation alone`);
    const body = bounds(frame.parts.body), original = bounds(PARTS.body);
    assert.deepEqual({left:body.left, right:body.right, bottom:body.bottom}, {left:original.left, right:original.right, bottom:original.bottom},
      `${state} keeps the original loaf proportions and floor`);
    if (state === 'yarn') {
      assert.equal(frame.viewport.pixelSize, 5, 'the expanded ball viewport keeps the original cat pixel size');
      assert.equal(frame.viewport.left * 5 + frame.viewport.offsetX, LEFT_PADDING * 5, 'extra ball space does not move the cat horizontally');
      assert.equal(frame.viewport.top * 5, TOP_PADDING * 5, 'extra ball space does not move the cat vertically');
    }
  }
});

test('stretch lifts the head and body together, reveals all paws at once and then raises only its back', () => {
  const frames = framesFor('stretch');
  const rest = frameForState('stand'), initial = frames[0];
  const legNames = ['paw-left','paw-right','foot-left','foot-right'];
  const exposed = frames.map(frame => legNames.every(part => frame.parts[part].length > 0));
  assert.deepEqual({duration:ANIMATIONS.stretch.duration, frames:ANIMATIONS.stretch.frames}, {duration:5800, frames:58},
    'the stretch adds one second at its highest point without changing the frame cadence');
  const frameDuration = ANIMATIONS.stretch.duration / ANIMATIONS.stretch.frames;
  assert.equal(frameDuration, 100, 'each frame keeps its original 100ms duration');
  assert.ok(!ANIMATIONS.stretch.once, 'stretch keeps playing like the other preview actions');
  assert.equal(signature(frames.at(-1).pixels), signature(initial.pixels), 'stretch returns to its original leg-free starting pose');
  assert.deepEqual(exposed.filter((value,index) => index === 0 || value !== exposed[index-1]), [false,true,false],
    'all paws appear in one step and disappear together on return');
  const firstPop = frames[exposed.indexOf(true)];
  assert.ok(firstPop, 'the full set of paws appears during the stretch');
  for (const part of ['head','body','tail','tail-tip']) {
    const before = initial.parts[part].filter(pixel => part !== 'body' || pixel.y !== 18);
    const after = firstPop.parts[part].filter(pixel => part !== 'body' || pixel.y !== 17).map(pixel => ({...pixel,y:pixel.y+1}));
    assert.equal(signature(after), signature(before), `${part} rises exactly one cell in the same first step without changing shape`);
  }
  const poppedHem = firstPop.parts.body.filter(pixel => pixel.y === 17 && pixel.x >= 5 && pixel.x <= 21);
  assert.ok(poppedHem.length === 17 && poppedHem.every(pixel => ['c','f'].includes(pixel.color) && visible(firstPop,pixel)),
    'the popped belly keeps its geometry while replacing the extra dark horizontal line with visible coat colors');
  const backHeights = frames.map(frame => bounds(frame.parts.body).top);
  assert.deepEqual(backHeights.filter((height,index) => index === 0 || height !== backHeights[index-1]), [4,3,2,3,4],
    'the whole-body lift happens before the back makes its separate extra step');
  const peak = frames[backHeights.indexOf(2)];
  assert.equal(backHeights.filter(height => height === 2).length * frameDuration, 2000,
    'the highest pose holds for the original second plus one extra second');
  const settling = backHeights.slice(backHeights.lastIndexOf(2) + 1);
  const settlingRuns = [];
  for (const top of settling) {
    const previous = settlingRuns.at(-1);
    if (previous?.top === top) previous.duration += frameDuration;
    else settlingRuns.push({top,duration:frameDuration});
  }
  assert.deepEqual(settlingRuns, [{top:3,duration:800},{top:4,duration:1000}], 'the downward step and final rest keep their previous timing');
  const symbols = frames.filter(frame => frame.phase === 'shake');
  assert.deepEqual(symbols.map(frame => frame.pose.symbolBeat), [0,1,-1,0], 'only the side symbol makes one short out-and-back motion');
  assert.ok(symbols.every((frame,index) => index === 0 || frame.index === symbols[index-1].index + 1),
    'the symbol motion occupies exactly one continuous window');
  assert.equal(new Set(symbols.map(frame => signature(frame.pixels))).size, 1, 'the entire cat stays still while the side symbol moves');
  assert.ok(symbols.every(frame => bounds(frame.parts.body).top === 2), 'the side symbol moves only during the highest hold');
  for (const frame of frames) {
    assert.equal(frame.pose.shakeX || 0, 0, 'the head and body never shake');
    if (frame.phase !== 'shake') assert.equal(frame.pose.symbolBeat, undefined, 'the side symbol does not repeat its motion outside the short window');
  }
  assert.ok(backHeights.indexOf(2) > exposed.indexOf(true), 'the extra back lift follows the complete paw reveal');
  assert.equal(signature(peak.parts.head), signature(firstPop.parts.head), 'the head stays still while only the back rises further');
  assert.equal(signature(peak.parts.body.filter(pixel => pixel.y >= 15)), signature(firstPop.parts.body.filter(pixel => pixel.y >= 15)),
    'the lower torso stays in place during the separate back lift');
  assert.deepEqual(initial.viewport, {width:33,height:27,left:0,top:1,baseline:22,rasterScale:10},
    'the viewport includes the raised tail without cropping or changing the body scale');
  for (const [index,frame] of frames.entries()) {
    assert.deepEqual(frame.viewport, initial.viewport, 'the canvas and rendering baseline stay fixed throughout the loop');
    assert.ok(legNames.every(part => exposed[index] ? frame.parts[part].length > 0 : frame.parts[part].length === 0),
      'the action has either no legs or four complete legs, with no partially revealed pose');
    for (const part of legNames) if (exposed[index]) {
      assert.equal(signature(frame.parts[part]), signature(rest.parts[part]), `${part} appears with its complete accepted geometry`);
      assert.equal(bounds(frame.parts[part]).bottom, 20, `${part} remains on the accepted floor after appearing`);
      assert.ok(frame.parts[part].every(pixel => visible(frame,pixel)), `${part} is fully visible immediately rather than exposing its toes first`);
    }
    if (!exposed[index]) {
      assert.equal(bounds(frame.parts.body).bottom, 18, 'the initial belly ends where the former second pose ended');
      assert.equal(bounds(frame.pixels).bottom, 18, 'there are no feet or partial toes below the initial belly');
      for (let x=5;x<=21;x++) assert.ok(frame.pixels.some(pixel => pixel.x === x && pixel.y === 18 && pixel.color === 'o'),
        'the initial leg-free belly has one continuous lower edge');
    }
    assert.equal(frame.parts.prop.length, 0, 'stretching does not introduce a task prop');
  }
  const oldIdleGesture = new Set(Array.from({ length: 32 }, (_, index) =>
    signature(frameForIdleAction('stretch', (index + 1e-6) / 32).pixels)));
  assert.ok(frames.some(frame => !oldIdleGesture.has(signature(frame.pixels))), 'the complete standing stretch remains distinct from the old tiny idle gesture');
});

test('the original cat follows an independent rolling ball with its head while its body and paws stay still', () => {
  const frames = framesFor('yarn');
  const ballPositions = frames.map(frame => bounds(frame.parts.prop).left);
  assert.ok(Math.min(...ballPositions) < 0 && Math.max(...ballPositions) > 8, 'the ball rolls from in front of the cat across its field of view');
  const directions = ballPositions.slice(1).map((x,index) => Math.sign(x - ballPositions[index])).filter(Boolean);
  assert.deepEqual(directions.filter((direction,index) => index === 0 || direction !== directions[index-1]), [1,-1],
    'the ball rolls toward the cat and returns once per loop');
  const gazeZones = new Map([-1,0,1].map(gaze => [gaze,[]]));
  for (const frame of frames) {
    for (const [part,pixels] of Object.entries(PARTS)) if (!['head','prop'].includes(part)) {
      assert.equal(signature(frame.parts[part]), signature(pixels), `${part} stays still while the cat watches the ball`);
    }
    assert.equal(frame.pose.headY, 0, 'watching never lifts or lowers the head');
    assert.equal(frame.pose.headX, frame.pose.gaze, 'the face and head turn together');
    assert.ok(gazeZones.has(frame.pose.gaze), 'the head uses a left, center or right glance');
    const ball = bounds(frame.parts.prop), center = (ball.left + ball.right) / 2;
    gazeZones.get(frame.pose.gaze).push(center);
    assert.deepEqual({width:ball.right-ball.left+1, height:ball.bottom-ball.top+1, top:ball.top, bottom:ball.bottom},
      {width:5,height:5,top:14,bottom:18}, 'the ball keeps its independent five-cell round shape in the foreground');
    const rows = Array.from({length:5}, (_,index) => frame.parts.prop.filter(pixel => pixel.y === ball.top + index).length);
    assert.ok(rows[0] < rows[2] && rows[4] < rows[2], 'the ball has rounded corners rather than a square outline');
    for (const color of ['o','p','d']) {
      assert.ok(frame.parts.prop.some(pixel => pixel.color === color && visible(frame,pixel)), 'the rolling ball retains a visible outline, fill and winding');
    }
    assert.ok(frame.parts.prop.every(pixel => visible(frame,pixel)), 'the complete ball stays visible in front of the stationary paws');
  }
  assert.ok([...gazeZones.values()].every(centers => centers.length > 0), 'the cat follows the ball with all three glance directions');
  assert.ok(Math.max(...gazeZones.get(-1)) < Math.min(...gazeZones.get(0)) && Math.max(...gazeZones.get(0)) < Math.min(...gazeZones.get(1)),
    'the gaze moves from left to right in the same order as the ball');
  assert.ok(frames.some(frame => bounds(frame.parts.prop).right < bounds(frame.parts.head).left), 'the ball can roll separately in front of the cat');
});

test('sleep keeps the original resting cat, closed theme-colored eyes and only a light breathing motion', () => {
  const frames = framesFor('belly');
  const resting = frameForState('idle',0), breathing = frameForState('idle',.4);
  const bodyStates = new Set([signature(resting.parts.body),signature(breathing.parts.body)]);
  const originalNose = expressionPixels('normal').find(pixel => pixel.color === 'n');
  const faces = [];
  for (const frame of frames) {
    assert.equal(frame.expression, 'sleep', 'the resting cat keeps its sleeping expression');
    assert.ok(bodyStates.has(signature(frame.parts.body)), 'breathing uses the accepted idle body shape');
    for (const [part,pixels] of Object.entries(PARTS)) if (part !== 'body') {
      assert.equal(signature(frame.parts[part]), signature(pixels), `${part} stays in its original resting pose without head or tail gestures`);
    }
    const face = expressionPixels(frame.expression, frame.pose);
    faces.push(signature(face));
    const nose = face.find(pixel => pixel.color === 'n'), eyes = face.filter(pixel => pixel.color === 'e');
    assert.deepEqual({x:nose.x,y:nose.y,color:nose.color}, {x:originalNose.x,y:originalNose.y,color:originalNose.color}, 'sleep leaves the original normal nose unchanged');
    assert.equal(eyes.length, 4, 'the sleeping eyes contain two theme-colored cells each');
    for (const side of [-1,1]) {
      const eye = eyes.filter(pixel => side * (pixel.x - nose.x) > 0).sort((first,second) => first.x-second.x);
      assert.equal(eye.length, 2, 'each sleeping eye is a short closed line');
      assert.equal(eye[1].x-eye[0].x, 1, 'the two eye cells sit next to each other');
      assert.equal(eye[1].y, eye[0].y, 'the sleeping eye is horizontal');
      assert.ok(eye.every(pixel => visible(frame,pixel)), 'both closed eyes remain visible on the original head');
    }
  }
  assert.equal(new Set(faces).size, 1, 'sleeping does not blink or change its face between breaths');
  assert.equal(new Set(frames.map(frame => signature(frame.parts.body))).size, 2, 'only the gentle idle breath animates the sleeping cat');
});
