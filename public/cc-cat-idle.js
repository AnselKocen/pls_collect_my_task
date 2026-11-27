(function (global) {
  'use strict';

  const LEG_MS = 30000, DWELL_MS = 22000, MOVE_MS = 8000, FIRST_DWELL_MS = 5000;
  const LIGHT_MS = 3000, LEISURE_MS = 10000, TICK_MS = 50;
  const WAYPOINTS = [1/3, 2/3, 1, 2/3, 1/3, 0];
  const LIGHT_ACTIONS = ['blink', 'ear'];
  const LEISURE_ACTIONS = ['look', 'tail', 'chin', 'stretch', 'yarn', 'belly', 'stretch-full'];
  const FULL_ACTION_STATES = { yarn:'yarn', belly:'belly', 'stretch-full':'stretch' };

  // Route progress and gesture intervals share an elapsed idle clock. Gestures
  // freeze that clock, but finish on real time so they can always release it.
  // The activity controller still owns every task and completion state.
  function create(options = {}) {
    const now = options.now || (() => global.performance.now());
    const later = options.setTimeout || ((fn, delay) => global.setTimeout(fn, delay));
    const cancel = options.clearTimeout || (id => global.clearTimeout(id));
    const random = options.random || Math.random;
    const emit = options.onUpdate || (() => {});
    const animations = options.animations || global.CCPixelCat?.ANIMATIONS || {};
    const canPlayAction = options.canPlayAction || (() => true);
    const leisureActions = LEISURE_ACTIONS.map(name => {
      const state = FULL_ACTION_STATES[name];
      return { name, ...(state ? { state } : {}), duration:state ? animations[state]?.duration : 2400 };
    }).filter(action => Number.isFinite(action.duration) && action.duration > 0);
    let bounds = { min:0, max:0, canRoam:true }, position = 0, from = 0;
    let waypoint = 0, epoch = 0, elapsed = 0, lastAt = 0, segmentStart = 0, lightBeat = 0, leisureBeat = 0;
    let active = false, destroyed = false, timer = null, action = null, phase = 'rest', suspendedAt = null;
    const clamp = value => Math.max(bounds.min, Math.min(bounds.max, value));
    const target = index => bounds.min + (bounds.max - bounds.min) * WAYPOINTS[index];

    function locate() {
      const complete = Math.floor(Math.max(0,elapsed-segmentStart)/LEG_MS);
      if (complete) {
        if (bounds.canRoam) {
          position = target((waypoint+complete-1)%WAYPOINTS.length);from = position;
          waypoint = (waypoint+complete)%WAYPOINTS.length;
        }
        segmentStart += complete*LEG_MS;
      }
      const segmentElapsed = Math.max(0,elapsed-segmentStart), destination = target(waypoint);
      phase = bounds.canRoam && Math.abs(destination-from) > .01 && segmentElapsed >= DWELL_MS ? 'walk' : 'rest';
      position = bounds.canRoam ? clamp(from+(destination-from)*Math.max(0,Math.min(1,(segmentElapsed-DWELL_MS)/MOVE_MS))) : from;
    }
    function advance(time) {
      const current = Math.max(lastAt,time);
      // Only the part after an action's real deadline can advance the route.
      // In particular, never stop this scheduler to pause the elapsed clock.
      const start = action ? Math.max(lastAt,action.startedAt+action.duration) : lastAt;
      elapsed += Math.max(0,current-start);
      if (action && current >= action.startedAt+action.duration) action = null;
      lastAt = current;
      locate();
    }
    function snapshot() {
      const segmentElapsed = elapsed-segmentStart;
      return { active, suspended:suspendedAt !== null, position, phase, waypoint, target:target(waypoint),
        elapsed, segmentElapsed, segmentAt:lastAt-segmentElapsed, epoch,
        direction:Math.sign(target(waypoint)-from), action:action ? { ...action } : null,
        bounds:{ ...bounds } };
    }
    function tick() {
      timer = null;
      if (!active || destroyed) return;
      const time = now();advance(time);
      const nextLight = Math.floor(elapsed/LIGHT_MS), nextLeisure = Math.floor(elapsed/LEISURE_MS);
      const lightDue = nextLight > lightBeat && elapsed-nextLight*LIGHT_MS <= TICK_MS*2;
      const leisureDue = nextLeisure > leisureBeat && elapsed-nextLeisure*LEISURE_MS <= TICK_MS*2;
      // Consume beats before starting an action: a frozen clock must never
      // retrigger the same beat. Simultaneous light gestures and missed beats
      // are discarded, including when no spatially safe action is available.
      lightBeat = nextLight;leisureBeat = nextLeisure;
      if (!action && leisureDue) {
        const available = leisureActions.filter(candidate => canPlayAction(candidate,snapshot()));
        if (available.length) {
          const index = Math.min(available.length-1,Math.max(0,Math.floor(random()*available.length)));
          action = { ...available[index], kind:'leisure', startedAt:time };
        }
      } else if (lightDue && !action) {
        action = { name:LIGHT_ACTIONS[(nextLight-1)%LIGHT_ACTIONS.length], kind:'light', startedAt:time, duration:900 };
      }
      emit(snapshot());
      if (active && !destroyed) timer = later(tick,TICK_MS);
    }
    function pause() {
      if (active) advance(now());
      active = false;phase = 'rest';action = null;suspendedAt = null;
      if (timer !== null) cancel(timer);timer = null;
      return position;
    }
    function suspend() {
      // Visibility pauses freeze the current timeline. Repeated hidden events
      // must not replace the original timestamp or consume background time.
      if (!active || destroyed) return position;
      const time = now();advance(time);suspendedAt = time;
      lightBeat = Math.floor(elapsed/LIGHT_MS);leisureBeat = Math.floor(elapsed/LEISURE_MS);
      active = false;phase = 'rest';action = null;
      if (timer !== null) cancel(timer);timer = null;
      return position;
    }
    function resumeSuspended() {
      if (destroyed || suspendedAt === null) return false;
      const time = now(), backgroundTime = Math.max(0,time-suspendedAt);
      epoch += backgroundTime;lastAt = time;
      suspendedAt = null;active = true;tick();
      return true;
    }
    function resume(nextBounds = bounds, nextPosition) {
      if (destroyed) return;
      pause();
      const min = Number.isFinite(nextBounds.min) ? nextBounds.min : 0;
      bounds = { min, max:Math.max(min,Number.isFinite(nextBounds.max) ? nextBounds.max : min), canRoam:nextBounds.canRoam !== false };
      position = from = clamp(Number.isFinite(nextPosition) ? nextPosition : position);
      if (bounds.canRoam && bounds.max-bounds.min > .01) {
        const minimumStep = (bounds.max-bounds.min)/12;
        // A new safe gap can put the preserved position at, or beyond, the
        // former stop. Keep following the route, but skip almost-zero steps
        // and targets behind us; passing an end stop naturally turns around.
        for (let skipped=0;skipped<WAYPOINTS.length;skipped++) {
          const direction = waypoint < WAYPOINTS.length/2 ? 1 : -1;
          if ((target(waypoint)-position)*direction >= minimumStep) break;
          waypoint = (waypoint+1)%WAYPOINTS.length;
        }
      }
      epoch = lastAt = now();elapsed = 0;
      // Shorten only the initial wait. Subsequent legs accumulate 22 seconds
      // resting and eight walking, with gesture playback excluded from both.
      segmentStart = -(DWELL_MS-FIRST_DWELL_MS);
      lightBeat = leisureBeat = 0;action = null;
      active = true;tick();
    }
    function destroy() { pause();destroyed = true; }
    return { resume, pause, suspend, resumeSuspended, snapshot, destroy };
  }

  const api = { create, LEG_MS, DWELL_MS, FIRST_DWELL_MS, MOVE_MS, LIGHT_MS, LEISURE_MS, CYCLE_MS:LEG_MS*WAYPOINTS.length, WAYPOINTS, LIGHT_ACTIONS, LEISURE_ACTIONS };
  global.CCPixelCatIdle = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
