(function () {
  'use strict';

  const layout = window.CatRoomLayout;
  const pixelCat = window.CCPixelCat;
  const $ = id => document.getElementById(id);
  const scene = $('scene'), image = $('room'), world = $('roomCatWorld');
  const cat = $('roomCat'), shadow = $('roomCatShadow'), foreground = $('roomForeground');
  const placeLabel = $('catLocation'), nextButton = $('catNextLocation'), autoButton = $('catAutoToggle'), note = $('catPlaceNote');
  if (!layout || !pixelCat || !layout.nodes?.length) {
    nextButton.disabled = true; autoButton.disabled = true;
    note.textContent = '小猫正在找舒服的位置';
    return;
  }

  const width = Number(layout.width) || 1254, height = Number(layout.height) || 1254;
  const catSizeMultiplier = 1.95;
  const nodes = new Map(layout.nodes.map(node => [node.id, node]));
  const orderedNodes = [...layout.nodes].sort((a, b) => a.number - b.number);
  const nodeNumber = node => String(node.number).padStart(2, '0');
  const nodeLabel = node => nodeNumber(node) + ' · ' + node.label;
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const ns = 'http://www.w3.org/2000/svg';
  const maskElements = new Map();
  const routeEdges = new Map([...nodes.keys()].map(id => [id, []]));
  let currentNode = null, destination = null, currentX = 0, currentY = 0, currentScale = 1;
  let activeMasks = [], moving = false, automatic = !motionPreference.matches;
  let animationFrame = null, idleTimer = null, gestureEndTimer = null, autoTimer = null, phaseTimer = null, transientTimer = null;
  let activityToken = 0;
  let behaviorPlan = [], behaviorCycle = false, phaseIndex = 0, phaseStartedAt = 0, phaseRemainingMs = Infinity;
  let autoDueAt = 0, autoDeparturePending = false, transientAction = null, resumeAfterAction = null, suspendedContext = null;
  let travelState = null;
  const clickActions = ['thinking', 'coding', 'looking', 'sweeping', 'error', 'happy', 'yarn', 'stand'].filter(state => pixelCat.ANIMATIONS[state]);
  const actionLabels = {idle:'安静趴着',belly:'睡个好觉',stretch:'伸个懒腰',looking:'好奇地四处看看',thinking:'认真想一想',coding:'忙一会儿小事情',sweeping:'打扫一下小角落',error:'有一点点小困惑',happy:'开心地挥挥爪',yarn:'玩一会儿毛线',stand:'站起来看看'};
  const now = () => performance.now();
  const randomDwell = () => 22000 + Math.random() * 18000;

  const makeSvg = (tag, attributes, parent) => {
    const element = document.createElementNS(ns, tag);
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, String(value)));
    parent.append(element); return element;
  };
  let sourceImage = layout.image || image.getAttribute('src');
  image.src = sourceImage; image.width = width; image.height = height;
  $('downloadScene').href = sourceImage;
  world.style.width = width + 'px'; world.style.height = height + 'px';
  foreground.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const definitions = makeSvg('defs', {}, foreground);
  (layout.masks || []).forEach((mask, index) => {
    const clipId = 'room-mask-' + index;
    const clip = makeSvg('clipPath', {id: clipId, clipPathUnits: 'userSpaceOnUse'}, definitions);
    if (mask.path) {
      makeSvg('path', {d: mask.path, 'clip-rule': mask.fillRule || 'evenodd', 'fill-rule': mask.fillRule || 'evenodd'}, clip);
    } else if (Array.isArray(mask.polygon)) {
      makeSvg('polygon', {points: mask.polygon.map(point => point.join(',')).join(' ')}, clip);
    }
    const cutout = makeSvg('image', {
      x: 0, y: 0, width, height, href: sourceImage,
      'clip-path': `url(#${clipId})`, 'data-mask': mask.id, 'aria-hidden': 'true',
      opacity: Number.isFinite(mask.opacity) ? Math.max(0,Math.min(1,mask.opacity)) : 1
    }, foreground);
    cutout.style.display = 'none';
    maskElements.set(mask.id, cutout);
  });

  function setMasks(ids) {
    activeMasks = [...new Set(ids || [])].filter(id => maskElements.has(id));
    maskElements.forEach((element, id) => { element.style.display = activeMasks.includes(id) ? '' : 'none'; });
  }
  function setImage(src) {
    if (typeof src !== 'string' || !src) return;
    sourceImage = src;
    image.src = src;
    maskElements.forEach(element => element.setAttribute('href', src));
    $('downloadScene').href = src;
    fitWorld();
  }
  function fitWorld() {
    // clientWidth excludes the viewer's zoom transform, avoiding double scaling.
    world.style.transform = `scale(${scene.clientWidth / width})`;
  }
  new ResizeObserver(fitWorld).observe(scene);
  window.addEventListener('resize', fitWorld);

  function placeCat(x, y, scale = currentScale) {
    currentX = Number(x); currentY = Number(y); currentScale = Number(scale) || 1;
    cat.style.left = (currentX - 75) + 'px';
    cat.style.top = (currentY - 117) + 'px';
    cat.style.setProperty('--room-cat-scale', String(.52 * currentScale * catSizeMultiplier));
    shadow.style.left = currentX + 'px'; shadow.style.top = currentY + 'px';
    shadow.style.width = (64 * currentScale * catSizeMultiplier) + 'px'; shadow.style.height = (9 * currentScale * catSizeMultiplier) + 'px';
    cat.dataset.sourceX = currentX.toFixed(2); cat.dataset.sourceY = currentY.toFixed(2);
  }

  function clearActivity() {
    activityToken++;
    clearTimeout(idleTimer); clearTimeout(gestureEndTimer); clearTimeout(autoTimer); clearTimeout(phaseTimer); clearTimeout(transientTimer);
    idleTimer = gestureEndTimer = autoTimer = phaseTimer = transientTimer = null;
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    autoDeparturePending = false;
  }
  function playState(state, progress = 0) {
    clearTimeout(idleTimer); clearTimeout(gestureEndTimer);
    idleTimer = gestureEndTimer = null;
    pixelCat.setState(cat, state);
    if (state === 'idle') pixelCat.setIdleAction(cat, 'rest');
    pixelCat.setProgress(cat, progress);
    if (!motionPreference.matches) pixelCat.play(cat);
  }
  function scheduleGesture() {
    clearTimeout(idleTimer);
    if (moving || transientAction || motionPreference.matches || document.hidden) return;
    const token = activityToken;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (token !== activityToken || moving || transientAction || document.hidden || !cat.classList.contains('st-idle')) return;
      const gestures = ['blink', 'blink', 'ear', 'look', 'tail'];
      const gesture = gestures[Math.floor(Math.random() * gestures.length)];
      pixelCat.setIdleAction(cat, gesture);
      gestureEndTimer = setTimeout(() => {
        gestureEndTimer = null;
        if (token !== activityToken || moving || transientAction) return;
        pixelCat.setIdleAction(cat, 'rest');
        if (autoDeparturePending) departForNextPlace();
        else scheduleGesture();
      }, pixelCat.IDLE_ACTIONS[gesture].duration);
    }, 4000 + Math.random() * 4500);
  }
  function updateAutoButton() {
    autoButton.setAttribute('aria-pressed', String(automatic));
    autoButton.textContent = automatic ? '自动闲逛中' : '自动闲逛';
  }
  function departForNextPlace() {
    if (!automatic || moving || transientAction || motionPreference.matches || document.hidden) return;
    const choices = layout.nodes.filter(node => node.id !== currentNode?.id);
    if (!choices.length) return;
    const connected = choices.filter(node => currentNode?.walkable !== false && node.walkable !== false && findRoutes(currentNode.id, node.id));
    const pool = connected.length && Math.random() < .7 ? connected : choices;
    goTo(pool[Math.floor(Math.random() * pool.length)].id);
  }
  function scheduleNextPlace() {
    clearTimeout(autoTimer);
    autoTimer = null;
    if (!automatic || moving || transientAction || motionPreference.matches || document.hidden || behaviorCycle) return;
    if (!autoDueAt) autoDueAt = now() + randomDwell();
    // Finite phases (for example yarn) finish before an automatic departure.
    if (Number.isFinite(phaseRemainingMs)) return;
    const token = activityToken;
    const state = behaviorPlan[phaseIndex]?.state || 'idle';
    const loop = state === 'idle' ? 0 : pixelCat.ANIMATIONS[state]?.duration || 0;
    const due = loop ? phaseStartedAt + Math.ceil(Math.max(autoDueAt - phaseStartedAt, 0) / loop) * loop : autoDueAt;
    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (!automatic || token !== activityToken || document.hidden || transientAction) return;
      if (gestureEndTimer !== null) autoDeparturePending = true;
      else departForNextPlace();
    }, Math.max(0, due - now()));
  }
  function planFor(node) {
    const configured = node.behavior?.phases?.filter(phase => pixelCat.ANIMATIONS[phase.state] && Number(phase.seconds) > 0);
    if (configured?.length) return configured.map(phase => ({state:phase.state,ms:Number(phase.seconds)*1000}));
    if (node.state === 'yarn') return [{state:'yarn',ms:8000},{state:'idle',ms:Infinity}];
    return [{state:node.state === 'belly' ? 'belly' : 'idle',ms:Infinity}];
  }
  function startPhase(index, remaining, progress = 0) {
    clearTimeout(phaseTimer); phaseTimer = null;
    phaseIndex = index; phaseStartedAt = now();
    phaseRemainingMs = remaining ?? behaviorPlan[phaseIndex].ms;
    const phase = behaviorPlan[phaseIndex];
    const state = motionPreference.matches && !['idle','belly'].includes(phase.state) ? 'idle' : phase.state;
    playState(state, progress);
    note.textContent = currentNode.note || (currentNode.state === 'yarn' && phaseIndex > 0 ? '玩累了，就在垫子上趴一会儿' : actionLabels[state] || '找个舒服的地方趴一会儿');
    if (state === 'idle') scheduleGesture();
    if (Number.isFinite(phaseRemainingMs) && !motionPreference.matches && !document.hidden) {
      const token = activityToken;
      phaseTimer = setTimeout(() => {
        phaseTimer = null;
        if (token !== activityToken || moving || transientAction || document.hidden) return;
        let next = phaseIndex + 1;
        if (next >= behaviorPlan.length) {
          // Finish a full behavior cycle before roaming. For 01 this retains
          // exactly 24s asleep + 6s stretching in every completed cycle.
          if (behaviorCycle && automatic && now() >= autoDueAt) { departForNextPlace(); return; }
          next = behaviorCycle ? 0 : behaviorPlan.length - 1;
        }
        startPhase(next);
      }, phaseRemainingMs);
    }
    scheduleNextPlace();
  }
  function beginRoutine(node) {
    behaviorPlan = planFor(node); behaviorCycle = node.behavior?.type === 'cycle' && behaviorPlan.every(phase => Number.isFinite(phase.ms));
    autoDueAt = automatic ? now() + randomDwell() : 0;
    startPhase(0);
  }
  function arrive(node, fromWalk = false) {
    moving = false; destination = null; travelState = null; currentNode = node;
    placeCat(node.x, node.y, node.scale || 1); setMasks(node.masks);
    if (node.facing || !fromWalk) cat.classList.toggle('flip', node.facing === 'right');
    cat.dataset.node = node.id; cat.dataset.moving = 'false';
    cat.dataset.number = nodeNumber(node);
    cat.setAttribute('aria-label',nodeLabel(node) + '的小猫，点击播放一个随机动作');
    placeLabel.value = nodeLabel(node);
    beginRoutine(node);
  }
  function captureContext() {
    if (moving && travelState && destination) {
      const path = travelState.segments.filter(segment => segment.until > travelState.at).map((segment, index) => ({
        points: [index === 0 ? [currentX,currentY] : segment.start, segment.end], masks: segment.masks
      }));
      return {kind:'travel',fromId:currentNode.id,targetId:destination.id,path};
    }
    return {
      kind:'routine',nodeId:currentNode.id,index:phaseIndex,
      remaining:Math.max(0,phaseRemainingMs-(now()-phaseStartedAt)),
      progress:pixelCat.getProgress(cat),autoRemaining:automatic ? Math.max(0,autoDueAt-now()) : 0
    };
  }
  function resumeContext(context) {
    if (!context) { if (currentNode) arrive(currentNode); return; }
    if (context.kind === 'travel') {
      currentNode = nodes.get(context.fromId) || currentNode;
      const target = nodes.get(context.targetId);
      if (target && context.finishInstantly) arrive(target);
      else if (target) walkTo(target, context.path);
      else if (currentNode) arrive(currentNode);
      return;
    }
    currentNode = nodes.get(context.nodeId) || currentNode;
    if (!currentNode) return;
    moving = false; destination = null; travelState = null;
    behaviorPlan = planFor(currentNode);
    behaviorCycle = currentNode.behavior?.type === 'cycle' && behaviorPlan.every(phase => Number.isFinite(phase.ms));
    autoDueAt = automatic ? now() + context.autoRemaining : 0;
    placeLabel.value = nodeLabel(currentNode);
    startPhase(Math.min(context.index,behaviorPlan.length-1),context.remaining,context.progress);
  }
  function runTransientAction(state, remaining, progress = 0) {
    const duration = remaining ?? pixelCat.ANIMATIONS[state].duration;
    transientAction = {state,startedAt:now(),remaining:duration};
    playState(state, progress);
    note.textContent = actionLabels[state] || '玩一个小动作';
    const token = activityToken;
    transientTimer = setTimeout(() => {
      transientTimer = null;
      if (token !== activityToken || !transientAction || document.hidden) return;
      const context = resumeAfterAction;
      transientAction = null; resumeAfterAction = null;
      clearActivity(); resumeContext(context);
    }, duration);
  }
  function playRandomAction() {
    if (!currentNode || !clickActions.length || document.hidden) return false;
    const previous = transientAction?.state;
    if (!transientAction) resumeAfterAction = captureContext();
    const choices = clickActions.filter(state => state !== previous);
    const pool = choices.length ? choices : clickActions;
    clearActivity(); moving = false; destination = null; travelState = null;
    cat.dataset.moving = 'false';
    runTransientAction(pool[Math.floor(Math.random()*pool.length)]);
    return true;
  }

  function distance(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i-1][0], points[i][1] - points[i-1][1]);
    return total;
  }
  (layout.routes || []).forEach(route => {
    const from = nodes.get(route.from), to = nodes.get(route.to);
    if (!from || !to || from.walkable === false || to.walkable === false) return;
    const points = [[from.x, from.y], ...(route.points || []), [to.x, to.y]];
    const cost = distance(points);
    routeEdges.get(from.id).push({to: to.id, points, masks: route.masks || [], cost});
    if (route.bidirectional !== false) routeEdges.get(to.id).push({to: from.id, points: [...points].reverse(), masks: route.masks || [], cost});
  });
  function findRoutes(start, goal) {
    if (!nodes.has(start) || !nodes.has(goal)) return null;
    const distances = new Map([[start, 0]]), previous = new Map(), pending = new Set(nodes.keys());
    while (pending.size) {
      const next = [...pending].reduce((best, id) => (distances.get(id) ?? Infinity) < (distances.get(best) ?? Infinity) ? id : best);
      if (!Number.isFinite(distances.get(next))) break;
      pending.delete(next); if (next === goal) break;
      for (const edge of routeEdges.get(next) || []) {
        if (!pending.has(edge.to)) continue;
        const cost = distances.get(next) + edge.cost;
        if (cost < (distances.get(edge.to) ?? Infinity)) { distances.set(edge.to, cost); previous.set(edge.to, {from: next, edge}); }
      }
    }
    if (!previous.has(goal)) return null;
    const result = []; let id = goal;
    while (id !== start) { const entry = previous.get(id); if (!entry) return null; result.unshift(entry.edge); id = entry.from; }
    return result;
  }

  function walkTo(node, path) {
    moving = true; destination = node; cat.dataset.moving = 'true';
    placeLabel.value = nodeLabel(node); note.textContent = '慢慢走到 ' + nodeLabel(node);
    cat.setAttribute('aria-label','正在走向 ' + nodeLabel(node) + '的小猫，点击播放一个随机动作');
    pixelCat.setState(cat, 'walk'); pixelCat.play(cat);
    const segments = [];
    let travelled = 0;
    for (const edge of path) {
      for (let i = 1; i < edge.points.length; i++) {
        const start = edge.points[i-1], end = edge.points[i];
        const length = Math.hypot(end[0]-start[0], end[1]-start[1]);
        if (length < .1) continue;
        segments.push({start, end, from: travelled, until: travelled+length, length, masks: [...(currentNode?.masks || []), ...(node.masks || []), ...edge.masks]});
        travelled += length;
      }
    }
    if (!segments.length) { arrive(node, true); return; }
    travelState = {segments,at:0};
    const startScale = currentScale, endScale = node.scale || 1;
    const token = activityToken, duration = travelled / 70 * 1000;
    let startedAt = null;
    const tick = time => {
      if (token !== activityToken) return;
      if (startedAt === null) startedAt = time;
      const progress = Math.min(1, (time-startedAt) / duration), at = travelled * progress;
      travelState.at = at;
      const segment = segments.find(part => at <= part.until) || segments[segments.length-1];
      const local = Math.max(0, Math.min(1, (at-segment.from) / segment.length));
      placeCat(segment.start[0]+(segment.end[0]-segment.start[0])*local, segment.start[1]+(segment.end[1]-segment.start[1])*local, startScale+(endScale-startScale)*progress);
      if (Math.abs(segment.end[0]-segment.start[0]) > 1) cat.classList.toggle('flip', segment.end[0] > segment.start[0]);
      setMasks(segment.masks);
      if (progress < 1) animationFrame = requestAnimationFrame(tick);
      else { animationFrame = null; arrive(node, true); }
    };
    animationFrame = requestAnimationFrame(tick);
  }

  function goTo(id, options = {}) {
    const node = nodes.get(id); if (!node) return false;
    const wasMoving = moving || resumeAfterAction?.kind === 'travel';
    clearActivity(); moving = false; destination = null;
    transientAction = null; resumeAfterAction = null; suspendedContext = null; travelState = null;
    if (options.manual) { automatic = false; updateAutoButton(); }
    const canWalk = currentNode && currentNode.id !== node.id && currentNode.walkable !== false && node.walkable !== false;
    const path = canWalk && !motionPreference.matches && !options.instant && !wasMoving ? findRoutes(currentNode.id, node.id) : null;
    if (path) walkTo(node, path);
    else arrive(node); // Upper-level places deliberately have no climb or jump animation.
    return true;
  }
  function setAuto(enabled) {
    automatic = !!enabled && !motionPreference.matches;
    updateAutoButton(); clearTimeout(autoTimer);
    autoTimer = null; autoDeparturePending = false;
    if (transientAction && resumeAfterAction?.kind === 'routine') {
      resumeAfterAction.autoRemaining = automatic ? randomDwell() : 0;
      return automatic;
    }
    if (transientAction && resumeAfterAction?.kind === 'travel') {
      resumeAfterAction.finishInstantly = !automatic;
      return automatic;
    }
    if (!automatic && moving && destination) {
      const target = destination; clearActivity(); arrive(target);
    } else if (automatic) { autoDueAt = now() + randomDwell(); scheduleNextPlace(); }
    return automatic;
  }

  orderedNodes.forEach(node => {
    const hotspot = document.createElement('button');
    hotspot.className = 'hotspot numbered'; hotspot.type = 'button'; hotspot.dataset.node = node.id;
    hotspot.textContent = nodeNumber(node);
    hotspot.style.setProperty('--x', `${node.x / width * 100}%`); hotspot.style.setProperty('--y', `${node.y / height * 100}%`);
    hotspot.setAttribute('aria-label', '让小猫去 ' + nodeLabel(node));
    hotspot.addEventListener('click', () => goTo(node.id, {manual: true}));
    $('roomNodeHotspots').append(hotspot);
  });
  nextButton.addEventListener('click', () => {
    const active = destination || nodes.get(resumeAfterAction?.targetId) || currentNode;
    const index = orderedNodes.findIndex(node => node.id === active?.id);
    goTo(orderedNodes[(index + 1) % orderedNodes.length].id, {manual: true});
  });
  autoButton.addEventListener('click', () => setAuto(!automatic));
  cat.addEventListener('pointerdown', event => event.stopPropagation());
  cat.addEventListener('click', event => { event.stopPropagation(); playRandomAction(); });
  cat.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); playRandomAction(); }
  });
  motionPreference.addEventListener('change', () => {
    const target = destination || nodes.get(resumeAfterAction?.targetId) || currentNode;
    clearActivity(); automatic = false; updateAutoButton();
    transientAction = null; resumeAfterAction = null; suspendedContext = null;
    if (target) arrive(target);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      suspendedContext = transientAction ? {
        kind:'transient',state:transientAction.state,
        remaining:Math.max(0,transientAction.remaining-(now()-transientAction.startedAt)),progress:pixelCat.getProgress(cat)
      } : currentNode ? captureContext() : null;
      clearActivity(); moving = false; destination = null; travelState = null;
      pixelCat.setProgress(cat,pixelCat.getProgress(cat));
    } else if (suspendedContext) {
      const context = suspendedContext; suspendedContext = null;
      if (context.kind === 'transient') runTransientAction(context.state,context.remaining,context.progress);
      else resumeContext(context);
    }
  });
  image.addEventListener('load', () => { fitWorld(); world.classList.add('ready'); });
  image.addEventListener('error', () => world.classList.remove('ready'));
  fitWorld(); if (image.complete && image.naturalWidth > 0) world.classList.add('ready');
  pixelCat.mount(cat); updateAutoButton();
  goTo(nodes.has(layout.defaultNode) ? layout.defaultNode : layout.nodes[0].id, {instant: true});

  window.CatRoomScene = {
    goTo,
    setImage,
    setAuto,
    playRandomAction,
    snapshot: () => {
      const paused = resumeAfterAction?.kind === 'routine' ? resumeAfterAction : suspendedContext?.kind === 'routine' ? suspendedContext : null;
      const index = paused?.index ?? phaseIndex;
      const remaining = paused ? paused.remaining : phaseRemainingMs-(now()-phaseStartedAt);
      return {nodeId:currentNode?.id || null,nodeNumber:currentNode?.number || null,destination:destination?.id || resumeAfterAction?.targetId || null,destinationNumber:destination?.number || nodes.get(resumeAfterAction?.targetId)?.number || null,position:[currentX,currentY],state:pixelCat.mount(cat)?.state || 'idle',masks:[...activeMasks],moving,automatic,transientAction:transientAction?.state || null,behaviorPhase:{index,state:behaviorPlan[index]?.state || null,remainingMs:Number.isFinite(remaining) ? Math.max(0,remaining) : null,cycle:behaviorCycle},reducedMotion:motionPreference.matches,source:{image:sourceImage,width,height}};
    }
  };
})();
