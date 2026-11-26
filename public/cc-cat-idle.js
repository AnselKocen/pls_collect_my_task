(function (global) {
  'use strict';

  const LEG_MS = 30000, DWELL_MS = 22000, MOVE_MS = 8000, FIRST_DWELL_MS = 5000;
  const LIGHT_MS = 3000, LEISURE_MS = 10000, TICK_MS = 50;
  const WAYPOINTS = [1/3, 2/3, 1, 2/3, 1/3, 0];
  const LIGHT_ACTIONS = ['blink', 'ear'];
  const LEISURE_ACTIONS = ['look', 'tail', 'chin', 'stretch'];

  // Only continuous idle time advances this plan. The activity controller still
  // owns every task and completion state; this scheduler never invents one.
  function create(options = {}) {
    const now = options.now || (() => global.performance.now());
    const later = options.setTimeout || ((fn, delay) => global.setTimeout(fn, delay));
    const cancel = options.clearTimeout || (id => global.clearTimeout(id));
    const random = options.random || Math.random;
    const emit = options.onUpdate || (() => {});
    let bounds = { min:0, max:0, canRoam:true }, position = 0, from = 0;
    let waypoint = 0, epoch = 0, segmentAt = 0, lightBeat = 0, leisureBeat = 0;
    let active = false, destroyed = false, timer = null, action = null, phase = 'rest', suspendedAt = null;
    const clamp = value => Math.max(bounds.min, Math.min(bounds.max, value));
    const target = index => bounds.min + (bounds.max - bounds.min) * WAYPOINTS[index];

    function locate(time) {
      const complete = Math.floor(Math.max(0,time-segmentAt)/LEG_MS);
      if (complete) {
        if (bounds.canRoam) {
          position = target((waypoint+complete-1)%WAYPOINTS.length);from = position;
          waypoint = (waypoint+complete)%WAYPOINTS.length;
        }
        segmentAt += complete*LEG_MS;
      }
      const elapsed = Math.max(0,time-segmentAt), destination = target(waypoint);
      phase = bounds.canRoam && Math.abs(destination-from) > .01 && elapsed >= DWELL_MS ? 'walk' : 'rest';
      position = bounds.canRoam ? clamp(from+(destination-from)*Math.max(0,Math.min(1,(elapsed-DWELL_MS)/MOVE_MS))) : from;
    }
    function snapshot() {
      return { active, suspended:suspendedAt !== null, position, phase, waypoint, target:target(waypoint), segmentAt, epoch,
        direction:Math.sign(target(waypoint)-from), action:action ? { ...action } : null,
        bounds:{ ...bounds } };
    }
    function tick() {
      timer = null;
      if (!active || destroyed) return;
      const time = now();locate(time);
      const age = Math.max(0,time-epoch);
      const nextLight = Math.floor(age/LIGHT_MS), nextLeisure = Math.floor(age/LEISURE_MS);
      const lightDue = nextLight > lightBeat && age-nextLight*LIGHT_MS <= TICK_MS*2;
      const leisureDue = nextLeisure > leisureBeat && age-nextLeisure*LEISURE_MS <= TICK_MS*2;
      // Advance the beats even when walking or doing another action. Conflicts
      // are discarded here, rather than queued for a burst of delayed gestures.
      lightBeat = nextLight;leisureBeat = nextLeisure;
      if (action && time >= action.startedAt+action.duration) action = null;
      if (phase === 'walk') action = null;
      else if (leisureDue) {
        const index = Math.min(LEISURE_ACTIONS.length-1,Math.max(0,Math.floor(random()*LEISURE_ACTIONS.length)));
        action = { name:LEISURE_ACTIONS[index], kind:'leisure', startedAt:time, duration:2400 };
      } else if (lightDue && !action) {
        action = { name:LIGHT_ACTIONS[(nextLight-1)%LIGHT_ACTIONS.length], kind:'light', startedAt:time, duration:900 };
      }
      emit(snapshot());
      if (active && !destroyed) timer = later(tick,TICK_MS);
    }
    function pause() {
      if (active) locate(now());
      active = false;phase = 'rest';action = null;suspendedAt = null;
      if (timer !== null) cancel(timer);timer = null;
      return position;
    }
    function suspend() {
      // Visibility pauses freeze the current timeline. Repeated hidden events
      // must not replace the original timestamp or consume background time.
      if (!active || destroyed) return position;
      const time = now();locate(time);suspendedAt = time;
      active = false;phase = 'rest';action = null;
      if (timer !== null) cancel(timer);timer = null;
      return position;
    }
    function resumeSuspended() {
      if (destroyed || suspendedAt === null) return false;
      const backgroundTime = Math.max(0,now()-suspendedAt);
      epoch += backgroundTime;segmentAt += backgroundTime;
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
      epoch = now();
      // Shorten only the initial wait. Later walks retain the 30-second rhythm,
      // while gesture beats still start from the actual beginning of idle time.
      segmentAt = epoch-(DWELL_MS-FIRST_DWELL_MS);
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
