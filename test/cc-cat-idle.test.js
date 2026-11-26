const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const idle = require('../public/cc-cat-idle');
const cat = require('../public/cc-cat');
const { create:activityController } = require('../public/cc-cat-controller');

function clock() {
  let time = 0, serial = 0;
  const timers = new Map();
  const api = {
    now:() => time,
    setTimeout(fn,delay) { const id = ++serial;timers.set(id,{ at:time+delay,fn });return id; },
    clearTimeout:id => timers.delete(id),
    advance(duration) {
      const end = time+duration;
      for (let loops=0;loops<20000;loops++) {
        const next = [...timers].filter(([,timer]) => timer.at<=end).sort((a,b) => a[1].at-b[1].at || a[0]-b[0])[0];
        if (!next) { time=end;return; }
        timers.delete(next[0]);time=next[1].at;next[1].fn();
      }
      throw new Error('Unbounded scheduler loop');
    },
    jump(duration) { time+=duration;const due=[...timers].filter(([,timer]) => timer.at<=time);for(const [id,timer] of due){timers.delete(id);timer.fn();} },
    pending:() => timers.size
  };
  return api;
}
function fixture(t,options={}) {
  const time = clock(), updates=[];
  const plan = idle.create({ ...time,random:() => 0,onUpdate:update => updates.push(update),...options });
  t.after(() => plan.destroy());
  plan.resume({ min:0,max:300 },0);
  return { time,plan,updates };
}
const near = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-6,`${actual} should equal ${expected}`);

test('the initial wait ends at five seconds and only the first leg is shortened',t => {
  const { time,plan }=fixture(t);
  assert.equal(idle.FIRST_DWELL_MS,5000);assert.equal(plan.snapshot().epoch,0);
  time.advance(4950);assert.equal(plan.snapshot().phase,'rest');near(plan.snapshot().position,0);
  time.advance(50);assert.equal(plan.snapshot().phase,'walk');near(plan.snapshot().position,0);
  time.advance(4000);near(plan.snapshot().position,50);
  time.advance(4000);assert.equal(plan.snapshot().phase,'rest');near(plan.snapshot().position,100);
  time.advance(21950);assert.equal(time.now(),34950);assert.equal(plan.snapshot().phase,'rest');near(plan.snapshot().position,100);
  time.advance(50);assert.equal(time.now(),35000);assert.equal(plan.snapshot().phase,'walk');near(plan.snapshot().position,100);
});

test('steady idle round trips keep six exact 22s rests and 8s walks over 180s',t => {
  const { time,plan } = fixture(t);
  assert.equal(idle.CYCLE_MS,180000);
  time.advance(163000);assert.equal(plan.snapshot().waypoint,0);near(plan.snapshot().position,0);
  const start=time.now();
  let from=0;
  for(const target of [100,200,300,200,100,0]) {
    near(plan.snapshot().position,from);
    time.advance(21950);assert.equal(plan.snapshot().phase,'rest');near(plan.snapshot().position,from);
    time.advance(50);assert.equal(plan.snapshot().phase,'walk');near(plan.snapshot().position,from);
    time.advance(4000);near(plan.snapshot().position,(from+target)/2);
    time.advance(4000);assert.equal(plan.snapshot().phase,'rest');near(plan.snapshot().position,target);
    from=target;
  }
  assert.equal(time.now()-start,180000);assert.equal(plan.snapshot().waypoint,0);near(plan.snapshot().position,0);
});

test('3s light gestures and 10s leisure gestures give way to walking without replay',t => {
  const { time,plan }=fixture(t);
  time.advance(3000);assert.equal(plan.snapshot().action.name,'blink');
  time.advance(900);assert.equal(plan.snapshot().action,null);
  time.advance(1100);assert.equal(plan.snapshot().phase,'walk');assert.equal(plan.snapshot().action,null);
  time.advance(1000);assert.equal(plan.snapshot().action,null,'6s light beat is skipped while walking');
  time.advance(4000);assert.equal(plan.snapshot().action,null,'10s leisure beat is skipped while walking');
  time.advance(3000);assert.equal(plan.snapshot().phase,'rest');assert.equal(plan.snapshot().action,null,'skipped gestures are not replayed at arrival');
  time.advance(2000);assert.equal(plan.snapshot().action.name,'blink');
  time.advance(5000);assert.equal(plan.snapshot().action.kind,'leisure');assert.equal(plan.snapshot().action.startedAt,20000);
  time.advance(1000);assert.equal(plan.snapshot().action.kind,'leisure','21s light beat is skipped');
  time.advance(9000);assert.equal(plan.snapshot().action.kind,'leisure','30s leisure takes precedence over a simultaneous light beat');
  time.advance(2400);assert.equal(plan.snapshot().action,null,'skipped gestures are not replayed when leisure ends');
  time.advance(600);assert.equal(plan.snapshot().action.kind,'light');
  time.advance(2000);assert.equal(plan.snapshot().phase,'walk');assert.equal(plan.snapshot().action,null);
  time.advance(1000);assert.equal(plan.snapshot().action,null,'36s light beat is skipped while walking');
  time.advance(4000);assert.equal(plan.snapshot().action,null,'40s leisure beat is skipped while walking');
});

test('task work and its existing success feedback freeze idle movement then restart from that position',t => {
  const { time,plan }=fixture(t);
  const controller=activityController({ ...time,onChange(state) {
    if(state==='idle') { if(!plan.snapshot().active)plan.resume(undefined,plan.snapshot().position); }
    else plan.pause();
  } });
  t.after(() => controller.destroy());
  time.advance(9000);near(plan.snapshot().position,50);
  const token=controller.begin('real-task','coding');near(plan.snapshot().position,50);assert.equal(plan.snapshot().active,false);
  time.advance(7000);controller.end('real-task',token);
  assert.equal(controller.getState(),'happy');time.advance(2799);assert.equal(plan.snapshot().active,false);near(plan.snapshot().position,50);
  time.advance(1);assert.equal(controller.getState(),'idle');assert.equal(plan.snapshot().active,true);near(plan.snapshot().position,50);
  time.advance(4950);near(plan.snapshot().position,50);assert.equal(plan.snapshot().phase,'rest');
  time.advance(4050);near(plan.snapshot().position,75);
  time.advance(4000);near(plan.snapshot().position,100);
});

test('pause clears pending beats and a resumed plan never catches up interrupted leisure',t => {
  const { time,plan,updates }=fixture(t);
  time.advance(20500);assert.equal(plan.snapshot().action.kind,'leisure');plan.pause();
  assert.equal(time.pending(),0);const count=updates.length;
  time.advance(90000);assert.equal(updates.length,count);
  plan.resume();assert.equal(plan.snapshot().action,null);time.advance(2950);assert.equal(plan.snapshot().action,null);
  time.advance(50);assert.equal(plan.snapshot().action.kind,'light');
});

test('resizing clamps the full position range and a stationary narrow fallback never drifts',t => {
  const { time,plan,updates }=fixture(t);
  time.advance(9000);const before=plan.pause();
  plan.resume({ min:150,max:450 },before);near(plan.snapshot().position,150);
  time.advance(90000);assert.ok(updates.every(update => update.position>=update.bounds.min && update.position<=update.bounds.max));
  plan.pause();plan.resume({ min:10,max:90,canRoam:false },45);
  const start=updates.length;time.advance(180000);
  for(const update of updates.slice(start)) { near(update.position,45);assert.equal(update.phase,'rest'); }
});

test('an overdue timer samples the current plan without replaying missed gestures',t => {
  const { time,plan }=fixture(t);
  time.jump(4000);assert.equal(plan.snapshot().action,null);
  time.jump(5000);assert.equal(plan.snapshot().phase,'walk');near(plan.snapshot().position,50);assert.equal(plan.snapshot().action,null);
});

test('a long stationary narrow-screen pause preserves the next route stop when space returns',t => {
  const { time,plan }=fixture(t);
  plan.pause();plan.resume({ min:0,max:300,canRoam:false },0);
  time.advance(65000);assert.equal(plan.snapshot().waypoint,0);near(plan.snapshot().position,0);
  plan.pause();plan.resume({ min:0,max:300 },0);
  assert.equal(plan.snapshot().target,100,'the next stop remains one third rather than jumping to the right end');
  time.advance(9000);near(plan.snapshot().position,50);
});

test('a changed safe gap skips a nearly coincident next stop instead of walking a fraction of a pixel',t => {
  const { time,plan }=fixture(t);
  plan.pause();plan.resume({ min:490.5,max:789.5 },589.84375);
  assert.equal(plan.snapshot().waypoint,1);near(plan.snapshot().target,689.8333333333334);
  assert.equal(plan.snapshot().direction,1);near(plan.snapshot().position,589.84375);
  time.advance(5000);near(plan.snapshot().position,589.84375);assert.equal(plan.snapshot().phase,'walk');
  time.advance(4000);near(plan.snapshot().position,(589.84375+689.8333333333334)/2);
});

test('resuming near either end turns toward the next meaningful stop',t => {
  const right=fixture(t);
  right.plan.pause();right.plan.resume({ min:0,max:300 },299);
  assert.equal(right.plan.snapshot().waypoint,3);assert.equal(right.plan.snapshot().target,200);assert.equal(right.plan.snapshot().direction,-1);
  right.time.advance(9000);near(right.plan.snapshot().position,249.5);

  const left=fixture(t);left.time.advance(133000);
  assert.equal(left.plan.snapshot().waypoint,5);
  left.plan.pause();left.plan.resume({ min:0,max:300 },.5);
  assert.equal(left.plan.snapshot().waypoint,0);assert.equal(left.plan.snapshot().target,100);assert.equal(left.plan.snapshot().direction,1);
});

test('the minimum useful resumed movement scales down for narrow valid gaps',t => {
  const { time,plan }=fixture(t);
  plan.pause();plan.resume({ min:10,max:22 },13.99);
  assert.equal(plan.snapshot().waypoint,1);assert.equal(plan.snapshot().target,18);assert.equal(plan.snapshot().direction,1);
  time.advance(9000);assert.equal(plan.snapshot().phase,'walk');near(plan.snapshot().position,15.995);
});

test('changed bounds preserve the route direction until its endpoint rather than walking backward to an old stop',t => {
  const right=fixture(t);right.plan.pause();right.plan.resume({ min:0,max:1200 },750);
  assert.equal(right.plan.snapshot().target,1200);assert.equal(right.plan.snapshot().direction,1);
  const left=fixture(t);left.time.advance(73000);
  left.plan.pause();left.plan.resume({ min:0,max:1200 },400);
  assert.equal(left.plan.snapshot().target,0);assert.equal(left.plan.snapshot().direction,-1);
});

test('resume without an explicit position preserves movement between timer samples',t => {
  const { time,plan }=fixture(t);
  time.advance(9025);near(plan.snapshot().position,50);
  plan.resume();near(plan.snapshot().position,50.3125);
});

test('visibility suspension preserves waiting progress instead of restarting the five-second initial rest',t => {
  const { time,plan }=fixture(t);
  time.advance(3700);near(plan.suspend(),0);assert.equal(plan.snapshot().suspended,true);assert.equal(time.pending(),0);
  time.advance(60000);assert.equal(plan.resumeSuspended(),true);
  assert.equal(plan.snapshot().epoch,60000);near(plan.snapshot().position,0);
  time.advance(1250);assert.equal(plan.snapshot().phase,'rest');
  time.advance(50);assert.equal(plan.snapshot().phase,'walk');
  time.advance(4000);near(plan.snapshot().position,50);
});

test('visibility suspension in a walk preserves its exact position and remaining movement time',t => {
  const { time,plan }=fixture(t);
  time.advance(9025);near(plan.suspend(),50.3125);
  const waypoint=plan.snapshot().waypoint,target=plan.snapshot().target;
  time.advance(45000);assert.equal(plan.resumeSuspended(),true);
  near(plan.snapshot().position,50.3125);assert.equal(plan.snapshot().phase,'walk');
  assert.equal(plan.snapshot().waypoint,waypoint);assert.equal(plan.snapshot().target,target);
  time.advance(3950);assert.equal(plan.snapshot().phase,'walk');
  time.advance(50);near(plan.snapshot().position,100);assert.equal(plan.snapshot().phase,'rest');
});

test('repeated hiding retains the first suspension and every restored timer has only one owner',t => {
  const { time,plan }=fixture(t);
  time.advance(2000);plan.suspend();time.advance(20000);plan.suspend();time.advance(30000);plan.suspend();
  assert.equal(time.pending(),0);assert.equal(plan.resumeSuspended(),true);assert.equal(plan.snapshot().epoch,50000);
  assert.equal(time.pending(),1);assert.equal(plan.resumeSuspended(),false);assert.equal(time.pending(),1);
  time.advance(3000);assert.equal(plan.snapshot().phase,'walk');
});

test('a task pause while hidden discards the visibility checkpoint and preserves the ordinary reset',t => {
  const { time,plan }=fixture(t);
  time.advance(3700);plan.suspend();time.advance(5000);plan.pause();
  assert.equal(plan.snapshot().suspended,false);assert.equal(plan.resumeSuspended(),false);
  time.advance(10000);plan.resume();
  time.advance(4950);assert.equal(plan.snapshot().phase,'rest');
  time.advance(50);assert.equal(plan.snapshot().phase,'walk');
});

test('interrupted idle gestures are discarded rather than replayed after visibility restoration',t => {
  const { time,plan }=fixture(t);
  time.advance(20500);assert.equal(plan.snapshot().action.kind,'leisure');plan.suspend();
  time.advance(90000);plan.resumeSuspended();assert.equal(plan.snapshot().action,null);
  time.advance(450);assert.equal(plan.snapshot().action,null);
  time.advance(50);assert.equal(plan.snapshot().action.kind,'light','the next scheduled beat still uses visible idle time');
});

test('visibility suspension at time zero is recoverable and destruction removes that checkpoint',t => {
  const { time,plan }=fixture(t);
  plan.suspend();time.advance(30000);assert.equal(plan.resumeSuspended(),true);
  plan.suspend();plan.destroy();assert.equal(plan.resumeSuspended(),false);assert.equal(plan.snapshot().suspended,false);
  assert.equal(time.pending(),0);
});

test('a steady round trip remains 180 seconds of visible idle across repeated rest and walk suspensions',t => {
  const { time,plan }=fixture(t);
  time.advance(163000);near(plan.snapshot().position,0);
  const initialVisibleTime=time.now()-plan.snapshot().epoch;
  for(const target of [100,200,300,200,100,0]) {
    time.advance(10000);plan.suspend();time.advance(60000);plan.resumeSuspended();
    time.advance(16000);assert.equal(plan.snapshot().phase,'walk');
    plan.suspend();time.advance(20000);plan.resumeSuspended();time.advance(4000);
    near(plan.snapshot().position,target);
  }
  assert.equal(time.now()-plan.snapshot().epoch-initialVisibleTime,180000);
  assert.equal(plan.snapshot().waypoint,0);near(plan.snapshot().position,0);
});

test('destroy and repeated resume leave no orphan timers',t => {
  const { time,plan }=fixture(t);
  plan.resume();plan.resume();assert.equal(time.pending(),1);
  plan.destroy();assert.equal(time.pending(),0);plan.resume();assert.equal(time.pending(),0);
});

test('idle-only gestures contain no task props and stay within the complete cat canvas',() => {
  for(const [name,animation] of Object.entries(cat.IDLE_ACTIONS)) {
    for(let i=0;i<animation.frames;i++) {
      const frame=cat.frameForIdleAction(name,(i+1e-6)/animation.frames);
      assert.equal(frame.pose.prop,undefined,`${name} must not introduce a task prop`);
      assert.equal(frame.parts.prop.length,0);
      for(const pixel of frame.pixels) {
        assert.ok(pixel.x>=-cat.LEFT_PADDING && pixel.x+(pixel.w ?? 1)<=cat.WIDTH);
        assert.ok(pixel.y>=-cat.TOP_PADDING && pixel.y+(pixel.h ?? 1)<=cat.HEIGHT);
      }
    }
  }
});

test('all original task and completion frames and durations match the pre-idle golden hashes',() => {
  const golden=require('./fixtures/cc-cat-task-frames.json');
  for(const [state,expected] of Object.entries(golden.states)) {
    const animation=cat.ANIMATIONS[state];
    assert.deepEqual(animation,{ duration:expected.duration,frames:expected.frames });
    const frames=Array.from({ length:animation.frames },(_,i) => cat.frameForState(state,(i+1e-6)/animation.frames));
    const hash=createHash('sha256').update(JSON.stringify({ animation,frames })).digest('hex');
    assert.equal(hash,expected.sha256,`${state}: every rendered pixel, pose, expression and frame duration must remain unchanged`);
  }
});
