(function (global) {
  'use strict';

  // Draw complete grid-aligned poses, with half cells for fine paw proportions.
  const WIDTH = 28, HEIGHT = 18, SIZE = HEIGHT;
  const LEFT_PADDING = 1;
  const TOP_PADDING = 4;
  const RENDER_SCALE = 2;
  const STATES = ['idle', 'thinking', 'coding', 'looking', 'sweeping', 'error', 'happy', 'stretch', 'yarn', 'belly', 'stand'];
  const ANIMATIONS = {
    idle: { duration: 5600, frames: 40 }, walk: { duration: 1120, frames: 8 },
    thinking: { duration: 3600, frames: 24 }, coding: { duration: 1600, frames: 12 },
    looking: { duration: 4000, frames: 24 }, sweeping: { duration: 2400, frames: 16 },
    error: { duration: 3200, frames: 20 }, happy: { duration: 2800, frames: 20 },
    stretch: { duration: 5800, frames: 58 }, yarn: { duration: 4000, frames: 40 },
    belly: { duration: 5600, frames: 56 }, stand: { duration: 4800, frames: 32 }
  };
  const COLOR_CODES = 'fopdenbsmctaklrh';
  // Idle-only gestures have their own schedule, separate from task actions
  // and their success/failure feedback timings.
  const IDLE_ACTIONS = {
    rest:{ duration:1, frames:1 }, blink:{ duration:900, frames:12 }, ear:{ duration:900, frames:12 },
    look:{ duration:2400, frames:32 }, tail:{ duration:2400, frames:32 },
    chin:{ duration:2400, frames:32 }, stretch:{ duration:2400, frames:32 }
  };
  const instances = new WeakMap(), mounted = new Set(), frameCache = new Map();
  let animationRequest = null;
  const motion = global.matchMedia?.('(prefers-reduced-motion: reduce)');

  // The stretch starts with a short, footless silhouette. Head and torso pop
  // up one cell together as the paws appear, then the back takes one more step.
  const REFERENCE_STAND_ROWS = [
    "..........................####...",
    ".........................#wwww##.",
    "........................#wwwwww#.",
    ".................#####..#wg##gww#",
    "................wwwwww##wg#..#gw#",
    "................wwwwwwg#wg#..#gw#",
    "................wwwwwwwwwg#..#gw#",
    "................wwwwwwwwwg#.#gw#.",
    "................wwwwwwwww#w#www#.",
    "................wwwwwwwww#w#ww#..",
    "................wwwwwwwwww#w##...",
    "................wwwwwwwwww#......",
    "................wwwwwwwwww#......",
    "...gwwwwwwwwwgggwwwwwwwwww#......",
    "...##ggggggggwwwwwwwwwwwww#......",
    "...#wwwwwwwwwwwwwgwwwwwwww#......",
    "...#wwwwwwwwwwwwwwgwwwwww#.......",
    "...#wwwwwwwwwwww###gwwwww#.......",
    "....#wwwgggwwwg#.#gdgwww#........",
    "....#wwwwswwww#..#ggdwww#........",
    ".....#wwwswwwg#...#gdwww#........",
    ".....#wwwdwww#....#gdww#.........",
    ".....#wwwdwww#....#gdww#.........",
    "......#ww#ww#.....#gdw#..........",
    "......#pp#pp#.....#w#w#..........",
    "......#######.....#####.........."
  ];
  function createReferenceStandParts(pose) {
    const parts = Object.fromEntries(Object.keys(PARTS).map(name=>[name,new Map()]));
    const put = (part,pixel) => parts[part].set(`${pixel.x},${pixel.y}`,pixel);
    PARTS.head.forEach(pixel=>put('head',{...pixel,x:pixel.x+pose.headX,y:pixel.y+pose.headY}));
    const colors = { w:'f', '#':'o', g:'s', s:'s', d:'m', p:'p' };
    const backLower = 2-(pose.backLift || 0);
    const chestCenter = expressionPixels('normal',pose).find(pixel=>pixel.color === 'n').x;
    const legOffset = chestCenter-9;
    REFERENCE_STAND_ROWS.forEach((row,y)=>{
      [...row].forEach((color,x)=>{
        if (color === '.') return;
        // Remove torso columns between the shoulders and haunch; move the
        // rear legs and complete curl together so all four feet keep their width.
        if ((y < 18 && x >= 16 && x <= 18) || (y >= 18 && y <= 22)) return;
        let part = 'body';
        if (x >= 24 && y <= 12) part = y < 8 ? 'tail-tip' : 'tail';
        else if (y >= 18) part = x <= 9 ? 'paw-left' : x <= 15 ? 'paw-right' : x <= 20 ? 'foot-left' : 'foot-right';
        let coat = colors[color];
        if (color === 'w' && x <= 12 && y >= 13) coat = 'c';
        if (color === 'w' && part === 'tail-tip' && y <= 2) coat = 't';
        const forepaw = part === 'paw-left' || part === 'paw-right';
        const leg = forepaw || part === 'foot-left' || part === 'foot-right';
        const lowerBack = part === 'tail-tip' || part === 'tail' || part === 'body' && y <= 12;
        put(part,{
          x:(x >= 17 ? x-3 : x)+(leg ? legOffset : 0),
          y:(y > 22 ? y-5 : y)+(lowerBack ? backLower : 0), color:coat
        });
      });
    });
    // Anchor the chest crease to the mouth while the back rises.
    for (const dx of [-1,0,1]) put('body',{x:chestCenter+dx,y:16,color:'s'});
    put('body',{x:chestCenter,y:17,color:'s'});
    // Close the footless starting silhouette. Once the paws appear, continue
    // the coat down to their roots without a dark horizontal seam.
    if (pose.popStretch) for (let x = 5; x <= 21; x++) {
      put('body',{x,y:18,color:pose.pawsOut ? (x <= 12 ? 'c' : 'f') : 'o'});
    }
    // Add one fur column to each rear leg, then shift the rear pair one cell
    // right. Keep the outlines thin and the front paws on their mouth centreline.
    for (const name of ['foot-left','foot-right']) {
      const source = [...parts[name].values()];
      const left = Math.min(...source.map(pixel=>pixel.x));
      const furColumn = left+(name === 'foot-left' ? 1 : 0);
      const shift = name === 'foot-left' ? 1 : 2;
      parts[name].clear();
      for (const pixel of source) {
        const x = pixel.x+shift+(pixel.x > furColumn ? 1 : 0);
        put(name,{...pixel,x});
        if (pixel.x === furColumn) put(name,{...pixel,x:x+1});
      }
      // Trim 0.2 of a cell from the last fur column, keeping a full-width edge.
      const widened = [...parts[name].values()];
      const trimColumn = Math.max(...widened.map(pixel=>pixel.x))-1;
      parts[name].clear();
      for (const pixel of widened) {
        if (pixel.x === trimColumn) put(name,{...pixel,w:.8});
        else if (pixel.x > trimColumn) put(name,{...pixel,x:Math.round((pixel.x-.2)*10)/10});
        else put(name,pixel);
      }
    }
    if (pose.popStretch) {
      for (const name of ['body','tail','tail-tip']) {
        const source = [...parts[name].values()];
        parts[name].clear();
        for (const pixel of source) put(name,{...pixel,y:pixel.y-pose.bodyLift});
      }
      // No paw artwork exists in the starting frame. All four approved paws
      // appear together at their original positions on the upward pop beat.
      if (!pose.pawsOut) for (const name of ['paw-left','paw-right','foot-left','foot-right']) parts[name].clear();
    }
    return Object.fromEntries(Object.entries(parts).map(([name,pixels])=>[name,[...pixels.values()]]));
  }

  function createYarnParts(pose) {
    // Use the same full-size loaf and glancing head as the looking action.
    const parts = createParts({...pose,yarn:false});
    const cells = new Map();
    const key = (x,y) => `${x},${y}`;
    const rows = [[0,1,3],[1,0,4],[2,0,4],[3,0,4],[4,1,3]];
    const mask = new Set();
    for (const [y,left,right] of rows) for (let x=left;x<=right;x++) mask.add(key(x,y));
    for (const position of mask) {
      const [x,y] = position.split(',').map(Number);
      const edge = [[-1,0],[1,0],[0,-1],[0,1]].some(([dx,dy]) => !mask.has(key(x+dx,y+dy)));
      cells.set(position,{x:x+pose.ballX,y:y+14,color:edge ? 'o' : 'p'});
    }
    const windings = [
      [[1,1],[2,2],[3,3]], [[3,1],[2,2],[1,3]],
      [[1,2],[2,2],[3,2]], [[2,1],[2,2],[2,3]]
    ];
    for (const [x,y] of windings[pose.winding]) cells.get(key(x,y)).color = 'd';
    parts.prop = [...cells.values()];
    return parts;
  }

  function createParts(pose = {}) {
    if (pose.referenceStand) return createReferenceStandParts(pose);
    if (pose.yarn) return createYarnParts(pose);
    const parts = {};
    const names = ['foot-back', 'tail-tip', 'tail', 'body', 'foot-left', 'foot-right', 'head', 'prop', 'paw-left', 'paw-right'];
    names.forEach(name => { parts[name] = new Map(); });
    const stride = WIDTH + 2;
    const keyFor = (x,y) => (y+TOP_PADDING) * stride + x + LEFT_PADDING;
    function dot(part, x, y, color, width = 1) {
      if (x >= -LEFT_PADDING && x < WIDTH && y >= -TOP_PADDING && y < HEIGHT) parts[part].set(keyFor(x,y), width === 1 ? { x, y, color } : { x, y, color, w:width });
    }
    function run(part, y, left, right, color) { for (let x = left; x <= right; x++) dot(part, x, y, color); }
    function span(part, y, left, width, color) {
      for (let offset = 0; offset < width; offset++) {
        const x = left+offset;
        const previous = parts[part].get(keyFor(x,y));
        const cellWidth = Math.min(1,width-offset);
        dot(part, x, y, color, previous?.color === color ? Math.max(cellWidth,previous.w ?? 1) : cellWidth);
      }
    }
    function rect(part, x, y, w, h, color) { for (let row = y; row < y + h; row++) run(part, row, x, x + w - 1, color); }
    function shape(part, rows, fill, openBottom = false) {
      const mask = new Set();
      rows.forEach(([y, left, right]) => { for (let x = left; x <= right; x++) mask.add(keyFor(x,y)); });
      for (const key of mask) {
        const x = key % stride - LEFT_PADDING, y = Math.floor(key / stride)-TOP_PADDING;
        const edge = !mask.has(key - 1) || !mask.has(key + 1) || !mask.has(key - stride) || (!openBottom && !mask.has(key + stride));
        dot(part, x, y, edge ? 'o' : fill);
      }
    }
    function recolor(part, x, y, color) {
      if (parts[part].get(keyFor(x,y))?.color !== 'o' && parts[part].has(keyFor(x,y))) dot(part, x, y, color);
    }

    const standing = !!pose.walk;
    const bodyLift = standing ? 1 : 0;
    const headY = pose.headY || 0;
    const headX = pose.headX || 0;
    const tailY = pose.tail || 0;
    // The fixed root overlaps both the haunch and moving tail tip.
    shape('tail-tip', [[13+tailY-bodyLift,23,26], [14+tailY-bodyLift,22,27], [15+tailY-bodyLift,22,26]], 't');
    rect('tail', 21, 13-bodyLift, 3, 3, 'o');
    rect('tail', 21, 14-bodyLift, 3, 1, 'f');
    const bodyRows = [[8-bodyLift,14,17], [9-bodyLift,10,19], [10-bodyLift,5,20], [11-bodyLift,3,21], [12-bodyLift,2,22], [13-bodyLift,2,22], [14-bodyLift,2,22], [15-bodyLift,3,22], [16-bodyLift,4,21]];
    // Give the walking body one extra row above the belly, keeping the paw roots.
    if (standing) bodyRows.splice(0,bodyRows.length,
      [6,14,17], [7,10,19], [8,5,20], [9,3,21], [10,2,22],
      [11,2,22], [12,2,22], [13,2,22], [14,3,22], [15,18,21]);
    if (pose.breathe) bodyRows.unshift([7-bodyLift,14,17]);
    shape('body', bodyRows, 'f');
    // A broad cream bib and one rump patch, rather than humanoid arms and belly.
    for (let y = 10-bodyLift; y <= 15-bodyLift; y++) {
      for (let x = 3; x <= 12 + Math.floor((y - 10 + bodyLift) / 2); x++) recolor('body', x, y, 'c');
    }
    const rumpLift = standing ? 1 : 0;
    for (let y = 9-bodyLift-rumpLift; y <= 12-bodyLift-rumpLift; y++) {
      for (let x = 17; x <= 21; x++) recolor('body', x, y, 'm');
    }
    // Only a hint of the tucked forepaws is visible in the loaf pose.
    if (!standing) {
      run('paw-left', 15, 5, 7, 'c'); dot('paw-left', 8, 15, 's');
      run('paw-right', 15, 10, 12, 'c');
    } else {
      const step = pose.step || 0;
      // Short front steps and the original tucked rear-paw cycle.
      const offsets = [[-1,0], [0,0], [1,0], [1,1], [0,1], [-1,1], [-1,0], [-1,0]];
      for (const [name, base, phase, color] of [
        ['paw-left',5,0,'c'], ['paw-right',10,4,'c']
      ]) {
        const [dx, lift] = offsets[(step + phase) % 8];
        const shorter = 0;
        const width = 3;
        rect(name, base, 13, width, 2-shorter, color);
        run(name, 15-lift-shorter, base+dx, base+dx+width-1, color);
        run(name, 16-lift-shorter, base+dx, base+dx+width-1, 'o');
        if (name === 'paw-right') {
          // The second front paw stays visible beneath the chest, including
          // a rounded toe edge when it is tucked one pixel off the ground.
          dot(name, base+dx-1, 15-lift-shorter, 'o');
          dot(name, base+dx+3, 15-lift-shorter, 'o');
        }
      }
      for (const [name, base, phase, color] of [
        ['foot-left',17,6,'s'], ['foot-right',19,2,'f']
      ]) {
        const [dx, lift] = offsets[(step + phase) % 8];
        const width = 2.5;
        for (const y of [13,14]) span(name, y, base, width, color);
        span(name, 15-lift, base+dx, width, color);
        if (color !== 's') span(name, 16-lift, base+dx, width, 'o');
      }
    }
    const earDrop = pose.earDrop || 0;
    // Expand the same head by one pixel around its cheeks and chin; raise the
    // forehead between the ears so the whole outline feels rounder.
    const headRows = [[0,4,4], [1,3,5], [2,2,6], [earDrop,13,13], [1+earDrop,12,14], [2,11,15], [2,6,11], [3,2,15], [4,1,16], [5,1,16], [6,0,17], [7,0,17], [8,0,17], [9,0,17], [10,1,16], [11,1,16], [12,2,15], [13,3,14], [14,4,13]];
    shape('head', headRows.map(([y,l,r]) => [y+headY,l+headX,r+headX]), 'f', true);
    // End the cheek line above the chest, without stray dark pixels on the bib.
    dot('head', 14+headX, 13+headY, 'f');
    dot('head', 13+headX, 14+headY, 'c');
    for (let y = 2; y <= 7; y++) for (let x = 2; x <= 6; x++) recolor('head', x+headX, y+headY, 'm');
    // The white muzzle flows into the chest, keeping the front and body one loaf.
    for (const [y,l,r] of [[8,8,9], [9,7,10], [10,6,11], [11,4,12], [12,3,12], [13,3,12], [14,4,12]]) {
      for (let x = l; x <= r; x++) recolor('head', x+headX, y+headY, 'c');
    }
    // Tiny ear interiors stay on the same pixel grid as the outline.
    dot('head', 4+headX, 3+headY, 'p');
    dot('head', 13+headX, 3+headY+earDrop, 'p');

    if (pose.paw === 'chin') {
      rect('paw-left', 4, 12, 3, 3, 'c'); run('paw-left', 11, 5, 7, 'o'); run('paw-left', 12, 5, 7, 'c');
    } else if (pose.paw === 'wave') {
      rect('paw-left', 2, 11, 4, 3, 'c'); run('paw-left', 10, 2, 3, 'o'); dot('paw-left', 1, 11, 'o');
      run('paw-left', 12, 1, 3, 'c'); dot('paw-left', 1, 13, 'o');
    }
    if (pose.prop === 'laptop') {
      // Resting paws must not remain visible through the front of the screen.
      parts['paw-left'].clear();
      parts['paw-right'].clear();
      rect('prop', 1, 13, 12, 4, 'o'); rect('prop', 2, 14, 10, 2, 'k');
      run('prop', 17, 0, 13, 'k'); run('prop', 15, 5, 7, 'a');
      const tap = pose.tap || 0;
      run('paw-left', 12+(tap === 1 ? 1 : 0), 3, 5, 'c');
      run('paw-right', 12+(tap === 2 ? 1 : 0), 9, 11, 'c');
    } else if (pose.prop === 'broom') {
      const sweep = pose.sweep || 0;
      rect('prop', 2+sweep, 10, 1, 5, 'r');
      run('prop', 15, 1+sweep, 3+sweep, 'h'); run('prop', 16, sweep, 4+sweep, 'h');
      dot('prop', 1+sweep, 17, 'r'); dot('prop', 3+sweep, 17, 'r');
      run('paw-left', 12, 2+sweep, 5, 'c'); dot('paw-left', 2+sweep, 11, 'o');
    }

    return Object.fromEntries(Object.entries(parts).map(([name,pixels]) => [name,[...pixels.values()]]));
  }

  function expressionPixels(expression = 'normal', pose = {}) {
    if (pose.hideFace) return [];
    if (expression === 'sleep') {
      const dx = pose.headX || 0, dy = pose.headY || 0;
      return [
        {x:5+dx,y:8+dy,color:'e'}, {x:6+dx,y:8+dy,color:'e'},
        {x:10+dx,y:8+dy,color:'e'}, {x:11+dx,y:8+dy,color:'e'},
        {x:8+dx,y:9+dy,color:'n'}
      ];
    }
    if (expression === 'gentle') {
      const pixels = [], dx = pose.headX || 0, dy = pose.headY || 0;
      const dot = (x,y,color='e')=>pixels.push({x:x+dx,y:y+dy,color});
      dot(8,9,'n');
      if (pose.blink) {
        dot(5.5,8); dot(10.5,8);
      } else {
        dot(4.5,7); dot(5.5,8);
        dot(11.5,7); dot(10.5,8);
      }
      for (const x of [3.5,4.5,11.5,12.5]) dot(x,9,'b');
      return pixels;
    }
    if (pose.face) {
      const {x,y}=pose.face, pixels=[];
      const dot=(dx,dy,color='e')=>pixels.push({x:x+dx,y:y+dy,color});
      dot(0,2,'n');
      const smiling=expression === 'smile' || expression === 'happy';
      for (const eye of [-2.5,2.5]) {
        if (smiling) { dot(eye-.5,0); dot(eye+.5,0); }
        else { if (!pose.blink) dot(eye,0); dot(eye,1); }
      }
      return pixels;
    }
    const pixels = [];
    const dx = pose.headX || 0, dy = pose.headY || 0;
    const gaze = pose.gaze || 0;
    const dot = (x,y,color = 'e',blink = false) => pixels.push({ x:x+dx, y:y+dy, color, blink });
    const smiling = expression === 'smile' || expression === 'happy';
    dot(smiling ? 7.5 : 8+gaze,9,'n');
    if (smiling) {
      for (const x of [4.5,10.5]) { dot(x,7); dot(x-1,8); dot(x+1,8); }
    } else {
      for (const x of [5.5,10.5]) {
        const y = expression === 'curious' && x === 10.5 ? 6 : 7;
        if (!pose.blink) dot(x+gaze,y,'e',true);
        dot(x+gaze,y+1);
      }
    }
    return pixels;
  }

  function compositeFrame(parts, expression = 'normal', pose = {}) {
    const pixels = new Map();
    const halfCellRemainders = new Set();
    const viewport = pose.viewport || { width:WIDTH+LEFT_PADDING, height:HEIGHT+TOP_PADDING, left:LEFT_PADDING, top:TOP_PADDING };
    const layers = pose.walk
      ? ['foot-back','foot-left','tail-tip','tail','body','foot-right','head','face','paw-left','paw-right']
      : pose.yarn
        ? ['foot-back','tail-tip','tail','body','foot-left','foot-right','head','face','paw-left','paw-right','prop']
        : ['foot-back','tail-tip','tail','body','foot-left','foot-right','head','face','prop','paw-left','paw-right'];
    layers.forEach(name => {
      const marks = name === 'face' ? expressionPixels(expression,pose) : parts[name] || [];
      marks.forEach(pixel => {
        if (pixel.x < -viewport.left || pixel.x >= viewport.width-viewport.left || pixel.y < -viewport.top || pixel.y >= viewport.height-viewport.top) return;
        const key = (pixel.y+viewport.top) * viewport.width + pixel.x + viewport.left;
        // A half-cell toe covers only half of the body beneath it; keep the
        // other half painted so a narrow paw cannot cut a hole in the haunch.
        if (pixel.w === .5) {
          const underneath = pixels.get(key);
          if (underneath && (underneath.w ?? 1) === 1) {
            pixels.set(key+.5, { x:pixel.x+.5, y:pixel.y, color:underneath.color, w:.5 });
            halfCellRemainders.add(key+.5);
          }
        } else if (halfCellRemainders.delete(key+.5)) pixels.delete(key+.5);
        pixels.set(key,pixel);
      });
    });
    return [...pixels.values()];
  }

  function frameForState(state, progress = 0) {
    const name = ANIMATIONS[state] ? state : 'idle';
    const animation = ANIMATIONS[name];
    const t = Number.isFinite(progress) ? ((progress % 1) + 1) % 1 : 0;
    const index = Math.min(animation.frames-1,Math.floor(t * animation.frames));
    const key = name + ':' + index;
    if (frameCache.has(key)) return frameCache.get(key);
    const p = index / animation.frames;
    const pose = {};
    let expression = name === 'happy' ? 'smile' : name === 'error' ? 'curious' : 'normal';
    if (name === 'walk') { pose.walk = true; pose.step = index; pose.tail = index === 3 || index === 4 ? -1 : 0; }
    if (name === 'idle') { pose.breathe = p >= .35 && p < .6 ? 1 : 0; pose.blink = index === 33 || index === 34; pose.tail = p >= .7 && p < .8 ? -1 : 0; }
    if (name === 'thinking') { pose.blink = index === 5 || index === 6 || index === 18; pose.earDrop = index === 10 || index === 12 ? 1 : 0; }
    if (name === 'coding') { pose.prop = 'laptop'; pose.headY = 1; pose.tap = index % 6 < 2 ? 1 : index % 6 >= 3 && index % 6 < 5 ? 2 : 0; pose.blink = index === 10; }
    if (name === 'looking') { pose.gaze = p >= .15 && p < .4 ? -1 : p >= .55 && p < .8 ? 1 : 0; pose.headX = pose.gaze; pose.earDrop = p >= .45 && p < .55 ? 1 : 0; }
    if (name === 'sweeping') { pose.prop = 'broom'; pose.sweep = p >= .25 && p < .65 ? 1 : 0; pose.gaze = -1; }
    if (name === 'error') { pose.earDrop = p >= .2 && p < .8 ? 1 : 0; pose.headY = p >= .3 && p < .6 ? 1 : 0; pose.blink = index === 17; }
    if (name === 'happy') { if (p >= .2 && p < .65) pose.paw = 'wave'; pose.tail = p >= .2 && p < .4 || p >= .5 && p < .65 ? -1 : 0; }
    if (name === 'belly') {
      pose.breathe = p >= .35 && p < .6 ? 1 : 0;
      expression = 'sleep';
    }
    if (name === 'yarn') {
      pose.yarn = true;
      const travel = Math.min(index,animation.frames-1-index);
      pose.ballX = -8+Math.min(20,Math.round(travel*20/16));
      pose.winding = (pose.ballX+8)%4;
      const centre = pose.ballX+2;
      pose.gaze = centre <= 4 ? -1 : centre >= 12 ? 1 : 0;
      pose.headX = pose.gaze;
      pose.headY = 0;
      pose.viewport = {width:37,height:23,left:9,top:4,pixelSize:5,baseline:21,offsetX:-40};
    }
    if (name === 'stand' || name === 'stretch') {
      pose.referenceStand = true;
      pose.headX = 0; pose.headY = 1;
      pose.viewport = {width:33,height:26,left:0,top:0,baseline:21,rasterScale:10};
      expression = 'gentle';
      if (name === 'stretch') {
        // Insert ten 100ms frames at the peak. Every other accepted pose and
        // beat keeps its original timing, including the one-step paw reveal.
        const beat = index < 30 ? index : index < 40 ? 29 : index-10;
        pose.popStretch = true;
        pose.pawsOut = beat >= 10 && beat < 38;
        pose.bodyLift = pose.pawsOut ? 1 : 0;
        pose.headY -= pose.bodyLift;
        // Preserve the lifted tail tip without moving the screen-space floor.
        pose.viewport = {...pose.viewport,height:27,top:1,baseline:22};
        // Whole-body lift first; a separate back-only step follows later.
        pose.backLift = beat >= 20 && beat < 30 ? 2 : 1;
        pose.blink = beat === 26 || beat === 27;
        // One small side-mark wiggle while the cat holds completely still.
        if (index >= 30 && index < 34) pose.symbolBeat = [0,1,-1,0][index-30];
      } else pose.blink = index === 21 || index === 22;
    }
    const parts = createParts(pose);
    const frame = {index,pose,expression,parts,pixels:compositeFrame(parts,expression,pose)};
    if (name === 'stretch') {
      if (pose.symbolBeat !== undefined) frame.phase = 'shake';
      frame.headPixelSize = 5;
      frame.bodyPixels = compositeFrame({...parts,head:[]},expression,{...pose,hideFace:true});
      frame.headPixels = compositeFrame({head:parts.head},expression,pose);
    }
    if (pose.viewport) frame.viewport = pose.viewport;
    frameCache.set(key,frame);
    return frame;
  }

  function frameForIdleAction(action, progress = 0) {
    const name = Object.hasOwn(IDLE_ACTIONS,action) ? action : 'rest';
    const animation = IDLE_ACTIONS[name];
    const p = Number.isFinite(progress) ? Math.max(0,Math.min(.999999,progress)) : 0;
    const index = Math.floor(p*animation.frames), key = 'idle-action:'+name+':'+index;
    if (frameCache.has(key)) return frameCache.get(key);
    const t = index/animation.frames, pose = {};
    if (name === 'blink') pose.blink = t >= .3 && t < .55;
    if (name === 'ear') pose.earDrop = t >= .25 && t < .6 ? 1 : 0;
    if (name === 'look') { pose.gaze = t >= .15 && t < .45 ? -1 : t >= .55 && t < .85 ? 1 : 0;pose.headX = pose.gaze; }
    if (name === 'tail') pose.tail = t >= .15 && t < .4 || t >= .55 && t < .8 ? -1 : 0;
    if (name === 'chin' && t >= .15 && t < .8) { pose.paw = 'chin';pose.blink = t >= .45 && t < .55; }
    if (name === 'stretch' && t >= .15 && t < .8) { pose.breathe = 1;pose.headY = -1;pose.blink = t >= .4 && t < .65; }
    const parts = createParts(pose), expression = 'normal';
    const frame = { index, pose, expression, parts, pixels:compositeFrame(parts,expression,pose) };
    frameCache.set(key,frame);return frame;
  }

  const PARTS = createParts();
  function currentState(container) {
    if (container.classList.contains('walking')) return 'walk';
    return STATES.find(state => container.classList.contains('st-'+state)) || 'idle';
  }
  function palette(record) {
    record.palette = Object.fromEntries([...record.swatches.children].map(swatch => [swatch.dataset.color,global.getComputedStyle(swatch).backgroundColor]));
  }
  function draw(record, now, force = false) {
    const idle = record.state === 'idle' && record.idleAction;
    const progress = record.manualProgress ?? (record.static || motion?.matches ? 0 : idle ? (now-idle.startedAt)/IDLE_ACTIONS[idle.name].duration : (now-record.startedAt) / ANIMATIONS[record.state].duration);
    const frame = idle ? frameForIdleAction(idle.name,progress) : frameForState(record.state,progress);
    const signature = record.state + ':' + (idle ? idle.name : '') + ':' + frame.index + ':' + record.expression;
    if (!force && signature === record.signature) return;
    record.signature = signature;
    const phase = frame.phase || record.state;
    if (record.container.dataset.catPhase !== phase) record.container.dataset.catPhase = phase;
    record.container.style.setProperty('--cat-shake-offset',((frame.pose.symbolBeat || 0)*2)+'px');
    const symbolTime = frame.index*ANIMATIONS[record.state].duration/ANIMATIONS[record.state].frames/1000;
    record.container.style.setProperty('--cat-symbol-time',symbolTime.toFixed(3)+'s');
    const pixels = frame.headPixelSize ? frame.bodyPixels : record.expression ? compositeFrame(frame.parts,record.expression,frame.pose) : frame.pixels;
    const viewport = frame.viewport || { width:WIDTH+LEFT_PADDING, height:HEIGHT+TOP_PADDING, left:LEFT_PADDING, top:TOP_PADDING };
    const rasterScale = viewport.rasterScale || RENDER_SCALE;
    if (record.canvas.width !== viewport.width*rasterScale || record.canvas.height !== viewport.height*rasterScale) {
      record.canvas.width = viewport.width*rasterScale; record.canvas.height = viewport.height*rasterScale;
      record.context.imageSmoothingEnabled = false; record.context.scale(rasterScale,rasterScale);
    }
    if (frame.viewport) {
      const pixelSize = viewport.pixelSize || 145/viewport.width;
      const height = pixelSize*viewport.height;
      const baseline = pixelSize*(viewport.baseline ?? viewport.height);
      record.art.style.width = (pixelSize*viewport.width)+'px';
      record.art.style.height = height+'px'; record.art.style.top = (117-baseline)+'px';
      record.art.style.left = (viewport.offsetX || 0)+'px';
    } else { record.art.style.removeProperty('width'); record.art.style.removeProperty('height'); record.art.style.removeProperty('top'); record.art.style.removeProperty('left'); }
    record.context.clearRect(0,0,viewport.width,viewport.height);
    for (const pixel of pixels) { record.context.fillStyle = record.palette[pixel.color]; record.context.fillRect(pixel.x+viewport.left,pixel.y+viewport.top,pixel.w ?? 1,pixel.h ?? 1); }
    if (frame.headPixelSize) {
      // Only the head uses the original idle's five-pixel cell size. The body
      // canvas, feet, tail and their screen positions retain the accepted scale.
      const head = frame.parts.head;
      const left = Math.min(...head.map(pixel=>pixel.x)), top = Math.min(...head.map(pixel=>pixel.y));
      const right = Math.max(...head.map(pixel=>pixel.x))+1, bottom = Math.max(...head.map(pixel=>pixel.y))+1;
      const width = right-left, height = bottom-top, headScale = 10;
      if (!record.headCanvas) {
        record.headCanvas = record.canvas.ownerDocument.createElement('canvas');
        record.headCanvas.className = 'cat-head-canvas';
        record.headCanvas.style.cssText = 'position:absolute;display:block;image-rendering:pixelated;pointer-events:none';
        record.art.append(record.headCanvas);
      }
      const headCanvas = record.headCanvas;
      if (headCanvas.width !== width*headScale || headCanvas.height !== height*headScale) {
        headCanvas.width = width*headScale; headCanvas.height = height*headScale;
      }
      const bodyPixel = viewport.pixelSize || 145/viewport.width;
      const anchor = expressionPixels('normal',frame.pose).find(pixel=>pixel.color === 'n').x+.5;
      headCanvas.style.left = ((anchor+viewport.left)*bodyPixel-(anchor-left)*frame.headPixelSize)+'px';
      headCanvas.style.top = ((bottom+viewport.top)*bodyPixel-height*frame.headPixelSize)+'px';
      headCanvas.style.width = (width*frame.headPixelSize)+'px';
      headCanvas.style.height = (height*frame.headPixelSize)+'px';
      const context = headCanvas.getContext('2d');
      context.setTransform(headScale,0,0,headScale,0,0);context.imageSmoothingEnabled = false;
      context.clearRect(0,0,width,height);
      const marks = record.expression ? compositeFrame({head},record.expression,frame.pose) : frame.headPixels;
      for (const pixel of marks) { context.fillStyle = record.palette[pixel.color]; context.fillRect(pixel.x-left,pixel.y-top,pixel.w ?? 1,pixel.h ?? 1); }
    } else if (record.headCanvas) {
      record.headCanvas.remove();record.headCanvas = null;
    }
  }
  function tick(now) {
    animationRequest = null;
    for (const record of mounted) {
      if (!record.container.isConnected) { record.observer?.disconnect(); mounted.delete(record); instances.delete(record.container); continue; }
      if (!record.static && record.manualProgress == null) draw(record,now);
    }
    schedule();
  }
  function schedule() {
    if (animationRequest !== null || !global.document || global.document.hidden || motion?.matches) return;
    if ([...mounted].some(record => !record.static && record.manualProgress == null)) animationRequest = global.requestAnimationFrame(tick);
  }
  function refresh(record) {
    const state = currentState(record.container);
    if (state !== record.state) { record.state = state; record.expression = null;record.idleAction = null; record.manualProgress = null; record.startedAt = global.performance.now(); palette(record); }
    draw(record,global.performance.now(),true);
    schedule();
  }
  function mount(container) {
    if (!container) return null;
    if (instances.has(container)) return instances.get(container);
    const sprite = container.querySelector('.cc-sprite');
    if (!sprite) return null;
    const document = sprite.ownerDocument;
    const art = document.createElement('div'); art.className = 'cc-cat-art'; art.setAttribute('aria-hidden','true');
    const canvas = document.createElement('canvas'); canvas.className = 'cat-canvas'; canvas.width = (WIDTH+LEFT_PADDING)*RENDER_SCALE; canvas.height = (HEIGHT+TOP_PADDING)*RENDER_SCALE;
    const swatches = document.createElement('div'); swatches.className = 'cat-palette';
    for (const code of COLOR_CODES) { const swatch = document.createElement('span'); swatch.className = 'cat-color-'+code; swatch.dataset.color = code; swatches.append(swatch); }
    art.append(canvas,swatches); sprite.classList.add('cc-cat-sprite'); sprite.replaceChildren(art);
    global.CCPixelCatSymbols?.mount(container);
    const record = { container, art, canvas, swatches, context:canvas.getContext('2d'), state:currentState(container), expression:null, startedAt:global.performance.now(), static:container.dataset.previewStatic === 'true' };
    record.context.imageSmoothingEnabled = false;
    // Keep full-size square eyes sharp when positioned halfway between grid cells.
    record.context.scale(RENDER_SCALE,RENDER_SCALE);
    instances.set(container,record); mounted.add(record); palette(record); refresh(record);
    if (typeof global.MutationObserver === 'function') { record.observer = new global.MutationObserver(() => refresh(record)); record.observer.observe(container,{ attributes:true,attributeFilter:['class'] }); }
    return record;
  }
  function setExpression(container,expression) {
    const record = mount(container);
    if (!record) return;
    refresh(record);
    record.expression = expression === 'happy' ? 'smile' : ['normal','curious','smile'].includes(expression) ? expression : null;
    draw(record,global.performance.now(),true);
  }
  function setState(container,state) {
    if (!container) return;
    const walking = state === 'walk' || state === 'walking';
    const next = STATES.includes(state) ? state : 'idle';
    STATES.forEach(name => container.classList.remove('st-'+name)); container.classList.add('st-'+next); container.classList.toggle('walking',walking);
    const record = mount(container);
    if (record) { record.expression = null; refresh(record); }
  }
  function setIdleAction(container,name = 'rest',startedAt = global.performance.now()) {
    const record = mount(container);
    if (!record || record.state !== 'idle') return;
    name = Object.hasOwn(IDLE_ACTIONS,name) ? name : 'rest';
    if (record.idleAction?.name === name && (name === 'rest' || record.idleAction.startedAt === startedAt)) return;
    record.idleAction = { name,startedAt };record.expression = null;
    draw(record,global.performance.now(),true);schedule();
  }
  function getProgress(container) {
    const record = mount(container);
    if (!record) return 0;
    if (record.manualProgress != null) return record.manualProgress;
    const idle = record.state === 'idle' && record.idleAction;
    const duration = idle ? IDLE_ACTIONS[idle.name].duration : ANIMATIONS[record.state].duration;
    return ((global.performance.now()-(idle ? idle.startedAt : record.startedAt))/duration)%1;
  }
  function setProgress(container,progress) {
    const record = mount(container);
    if (!record) return;
    record.manualProgress = Number.isFinite(progress) ? Math.max(0,Math.min(1-1e-8,progress)) : 0;
    draw(record,global.performance.now(),true);
  }
  function play(container) {
    const record = mount(container);
    if (!record || record.manualProgress == null) return;
    const idle = record.state === 'idle' && record.idleAction;
    const duration = idle ? IDLE_ACTIONS[idle.name].duration : ANIMATIONS[record.state].duration;
    const startedAt = global.performance.now()-record.manualProgress*duration;
    if (idle) idle.startedAt = startedAt;
    else record.startedAt = startedAt;
    record.manualProgress = null;
    draw(record,global.performance.now(),true);schedule();
  }
  function mountAll(root = global.document) { root?.querySelectorAll('.cc-container').forEach(mount); }
  function repaint() { for (const record of mounted) { palette(record); draw(record,global.performance.now(),true); } schedule(); }
  const api = { SIZE,WIDTH,HEIGHT,LEFT_PADDING,TOP_PADDING,STATES,ANIMATIONS,IDLE_ACTIONS,PARTS,createParts,expressionPixels,compositeFrame,frameForState,frameForIdleAction,mount,mountAll,setExpression,setState,setIdleAction,getProgress,setProgress,play };
  global.CCPixelCat = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (global.document) {
    mountAll();
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded',() => mountAll(),{ once:true });
    const themeObserver = new global.MutationObserver(repaint);
    themeObserver.observe(global.document.documentElement,{ attributes:true,attributeFilter:['data-theme','style'] });
    motion?.addEventListener('change',repaint);
    global.document.addEventListener('visibilitychange',() => { if (!global.document.hidden) schedule(); });
  }
})(typeof window === 'object' ? window : globalThis);
