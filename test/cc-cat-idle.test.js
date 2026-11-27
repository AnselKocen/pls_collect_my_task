const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const idle = require('../public/cc-cat-idle');
const cat = require('../public/cc-cat');
const { create:activityController } = require('../public/cc-cat-controller');

function clock() {
  let time = 0, serial = 0;
  const timers = new Map();
  return {
    now:() => time,
    setTimeout(fn,delay) { const id = ++serial;timers.set(id,{ at:time+delay,fn });return id; },
    clearTimeout:id => timers.delete(id),
    advance(duration) {
      const end = time+duration;
      for (let loops=0;loops<50000;loops++) {
        const next = [...timers].filter(([,timer]) => timer.at<=end).sort((a,b) => a[1].at-b[1].at || a[0]-b[0])[0];
        if (!next) { time=end;return; }
        timers.delete(next[0]);time=next[1].at;next[1].fn();
      }
      throw new Error('Unbounded scheduler loop');
    },
    jump(duration) { time+=duration;const due=[...timers].filter(([,timer]) => timer.at<=time);for(const [id,timer] of due){timers.delete(id);timer.fn();} },
    pending:() => timers.size
  };
}
function fixture(t,options={}) {
  const time=clock(),updates=[];
  const plan=idle.create({...time,animations:cat.ANIMATIONS,random:()=>0,onUpdate:update=>updates.push(update),...options});
  t.after(()=>plan.destroy());plan.resume({min:0,max:300},0);
  return {time,plan,updates};
}
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-6,`${actual} should equal ${expected}`);

// Drive the real scheduler, including every action, until a requested amount
// of unpaused idle time has accrued. A deadline makes a stuck/replayed action
// fail rather than allowing the test helper itself to wait forever.
function advanceElapsed(f,target) {
  const start=f.plan.snapshot();
  assert.ok(Number.isFinite(start.elapsed),'the scheduler exposes cumulative effective idle time');
  assert.ok(target>=start.elapsed,'effective time only advances');
  const deadline=f.time.now()+5*(target-start.elapsed)+60000;
  while(f.plan.snapshot().elapsed<target && f.time.now()<deadline) f.time.advance(Math.min(50,target-f.plan.snapshot().elapsed));
  near(f.plan.snapshot().elapsed,target);
  return f.plan.snapshot();
}
function controllerFor(t,f) {
  const controller=activityController({...f.time,onChange(state){
    if(state==='idle') { if(!f.plan.snapshot().active)f.plan.resume(undefined,f.plan.snapshot().position); }
    else f.plan.pause();
  }});
  t.after(()=>controller.destroy());return controller;
}
function choose(name) { return ()=>(idle.LEISURE_ACTIONS.indexOf(name)+.5)/idle.LEISURE_ACTIONS.length; }


test('the first wait consumes five effective seconds and excludes the first light action',t=>{
  const f=fixture(t),{time,plan}=f;
  assert.equal(idle.FIRST_DWELL_MS,5000);assert.equal(plan.snapshot().epoch,0);
  assert.equal(plan.snapshot().elapsed,0);assert.equal(plan.snapshot().segmentElapsed,17000);
  time.advance(3000);const blink=plan.snapshot();assert.equal(blink.action.name,'blink');
  time.advance(850);near(plan.snapshot().elapsed,3000);near(plan.snapshot().position,0);
  time.advance(50);assert.equal(plan.snapshot().action,null);near(plan.snapshot().elapsed,3000);
  time.advance(1950);assert.equal(plan.snapshot().phase,'rest');near(plan.snapshot().elapsed,4950);
  time.advance(50);assert.equal(plan.snapshot().phase,'walk');near(plan.snapshot().position,0);
  near(plan.snapshot().elapsed,5000);near(plan.snapshot().segmentElapsed,22000);assert.equal(time.now(),5900);
  advanceElapsed(f,9000);near(plan.snapshot().position,50);
  advanceElapsed(f,13000);assert.equal(plan.snapshot().phase,'rest');near(plan.snapshot().position,100);
  advanceElapsed(f,34950);assert.equal(plan.snapshot().phase,'rest');
  advanceElapsed(f,35000);assert.equal(plan.snapshot().phase,'walk');near(plan.snapshot().position,100);
});

test('steady round trips retain six 22s rests and 8s walks in effective time',t=>{
  const f=fixture(t),{time,plan}=f;
  assert.equal(idle.CYCLE_MS,180000);
  advanceElapsed(f,163000);assert.equal(plan.snapshot().waypoint,0);near(plan.snapshot().position,0);
  const start=time.now();let from=0,elapsed=163000;
  for(const target of [100,200,300,200,100,0]) {
    near(plan.snapshot().position,from);
    advanceElapsed(f,elapsed+21950);assert.equal(plan.snapshot().phase,'rest');near(plan.snapshot().position,from);
    advanceElapsed(f,elapsed+22000);assert.equal(plan.snapshot().phase,'walk');near(plan.snapshot().position,from);
    advanceElapsed(f,elapsed+26000);near(plan.snapshot().position,(from+target)/2);
    advanceElapsed(f,elapsed+30000);assert.equal(plan.snapshot().phase,'rest');near(plan.snapshot().position,target);
    from=target;elapsed+=30000;
  }
  assert.equal(plan.snapshot().elapsed-163000,180000);assert.ok(time.now()-start>180000,'actions extend wall time instead of consuming route time');
  assert.equal(plan.snapshot().waypoint,0);near(plan.snapshot().position,0);
});

test('a light gesture pauses an in-progress walk and resumes its exact remaining movement',t=>{
  const f=fixture(t),{time,plan}=f;
  const action=advanceElapsed(f,6000);assert.equal(action.phase,'walk');assert.equal(action.action.name,'ear');near(action.position,12.5);
  time.advance(450);const halfway=plan.snapshot();near(halfway.elapsed,6000);near(halfway.position,12.5);near(halfway.segmentElapsed,23000);
  near(halfway.segmentAt-action.segmentAt,450);
  time.advance(450);assert.equal(plan.snapshot().action,null);near(plan.snapshot().elapsed,6000);
  advanceElapsed(f,7000);near(plan.snapshot().position,25);
});

test('3s and 10s share effective time, long wins collisions, and consumed beats never replay',t=>{
  const f=fixture(t),{time,plan,updates}=f;
  const long=advanceElapsed(f,10000);assert.equal(long.action.name,'look');assert.equal(long.phase,'walk');near(long.position,62.5);
  time.advance(2400);assert.equal(plan.snapshot().action,null);near(plan.snapshot().elapsed,10000);
  time.advance(50);assert.equal(plan.snapshot().action,null);near(plan.snapshot().elapsed,10050);
  assert.equal(advanceElapsed(f,12000).action.name,'ear','the 10s action does not reset the 3s clock');
  const collision=advanceElapsed(f,30000);assert.equal(collision.action.kind,'leisure');assert.equal(collision.action.name,'look');
  const count=updates.length;time.advance(2400);assert.equal(plan.snapshot().action,null);near(plan.snapshot().elapsed,30000);
  time.advance(50);assert.equal(plan.snapshot().action,null,'the simultaneous light beat was consumed, not deferred');
  assert.equal(updates.slice(count).some(update=>update.action?.kind==='light'),false);
  assert.equal(advanceElapsed(f,33000).action.kind,'light','the next distinct light beat still runs');
});

for(const [name,state] of [['yarn','yarn'],['belly','belly'],['stretch-full','stretch']]) {
  test(`${name} uses real time to finish while effective time and the task model stay frozen`,t=>{
    const f=fixture(t,{random:choose(name)}),{time,plan,updates}=f;
    const controller=controllerFor(t,f),start=advanceElapsed(f,10000),action=start.action;
    assert.equal(action.name,name);assert.equal(action.state,state);assert.equal(action.duration,cat.ANIMATIONS[state].duration);
    assert.equal(controller.getState(),'idle');assert.equal(controller.isBusy(),false);assert.equal(start.phase,'walk');
    const count=updates.length;time.advance(action.duration-50);
    for(const update of updates.slice(count)) {
      assert.equal(update.action?.startedAt,action.startedAt);assert.equal(update.action?.state,state);
      near(update.elapsed,start.elapsed);near(update.position,start.position);near(update.segmentElapsed,start.segmentElapsed);
    }
    time.advance(50);assert.equal(plan.snapshot().action,null);near(plan.snapshot().elapsed,10000);
    time.advance(50);near(plan.snapshot().elapsed,10050);assert.equal(plan.snapshot().action,null,'the spent 10s event cannot restart the action');
  });
}

test('long actions near route transitions finish completely before the effective route resumes',t=>{
  const f=fixture(t,{random:choose('stretch-full')}),{time,plan}=f;
  const at=advanceElapsed(f,10000);assert.equal(at.action.state,'stretch');assert.equal(at.phase,'walk');near(at.position,62.5);
  time.advance(5800);near(plan.snapshot().elapsed,10000);near(plan.snapshot().position,62.5);assert.equal(plan.snapshot().action,null);
  advanceElapsed(f,13000);near(plan.snapshot().position,100);assert.equal(plan.snapshot().phase,'rest');
  const next=advanceElapsed(f,30000);assert.equal(next.action.state,'stretch','full animations are no longer filtered by unpaused route time remaining');
});

test('a delayed completion counts only the time after the real action end',t=>{
  const f=fixture(t,{random:choose('stretch-full')}),{time,plan}=f;
  advanceElapsed(f,10000);time.jump(6300);
  assert.equal(plan.snapshot().action,null);near(plan.snapshot().elapsed,10500);near(plan.snapshot().position,68.75);
});

test('full animations yield immediately to tasks and ordinary feedback restarts idle at the same position',t=>{
  const f=fixture(t,{random:choose('stretch-full')}),{time,plan}=f,controller=controllerFor(t,f);
  advanceElapsed(f,10000);time.advance(500);const frozen=plan.snapshot().position;
  const token=controller.begin('real-task','coding');
  assert.equal(plan.snapshot().active,false);assert.equal(plan.snapshot().action,null);near(plan.snapshot().position,frozen);assert.equal(time.pending(),0);
  time.advance(3000);controller.end('real-task',token);assert.equal(controller.getState(),'happy');
  time.advance(2799);assert.equal(plan.snapshot().active,false);near(plan.snapshot().position,frozen);
  time.advance(1);assert.equal(controller.getState(),'idle');assert.equal(plan.snapshot().action,null);near(plan.snapshot().elapsed,0);
  advanceElapsed(f,4950);assert.equal(plan.snapshot().phase,'rest');near(plan.snapshot().position,frozen);
  advanceElapsed(f,5000);assert.equal(plan.snapshot().phase,'walk');near(plan.snapshot().position,frozen);
  advanceElapsed(f,9000);near(plan.snapshot().position,(frozen+100)/2);
});

test('spatial exclusion leaves other actions and route progress available',t=>{
  const f=fixture(t,{random:()=>.65,canPlayAction:action=>action.state!=='yarn'});
  assert.equal(advanceElapsed(f,10000).action.kind,'leisure');
  advanceElapsed(f,35000);assert.equal(f.plan.snapshot().phase,'walk');near(f.plan.snapshot().position,100);
  assert.equal(f.updates.some(update=>update.action?.state==='yarn'),false);
});

test('an empty leisure pool consumes the event without stalling, retrying or replaying a colliding light',t=>{
  let calls=0;
  const f=fixture(t,{canPlayAction:()=>{calls++;return false;}}),{time,plan}=f;
  advanceElapsed(f,10000);assert.equal(plan.snapshot().action,null);const consumed=calls;
  time.advance(50);assert.equal(calls,consumed);near(plan.snapshot().elapsed,10050);
  advanceElapsed(f,30000);assert.equal(plan.snapshot().action,null,'long priority discards the simultaneous light event even with no candidate');
  const collisionCalls=calls;time.advance(1000);assert.equal(calls,collisionCalls);near(plan.snapshot().elapsed,31000);
  advanceElapsed(f,35000);assert.equal(plan.snapshot().phase,'walk');near(plan.snapshot().position,100);
});

test('long advancement keeps actions finite, timers bounded, and both walking and leisure alive',t=>{
  const f=fixture(t,{random:choose('stretch-full')}),{time,plan,updates}=f;
  advanceElapsed(f,360000);assert.ok(time.now()>360000);assert.ok(time.now()<1000000);
  const starts=updates.filter((update,index)=>update.action && update.action.startedAt!==updates[index-1]?.action?.startedAt);
  const unique=new Set(starts.map(update=>update.action.startedAt));assert.equal(unique.size,starts.length);
  assert.equal(starts.filter(update=>update.action.kind==='leisure').length,36);
  assert.ok(starts.some(update=>update.action.kind==='light'));
  assert.ok(updates.some(update=>update.phase==='walk'&&!update.action));
  assert.equal(time.pending(),1);assert.equal(plan.snapshot().active,true);
});

test('the actual scheduler runs six continuous wall-clock hours through hundreds of stops without retaining updates',t=>{
  let stops=0,previousWaypoint=0,leisureStarts=0,lightStarts=0,previousAction=null;
  const f=fixture(t,{random:choose('stretch-full'),onUpdate(update){
    assert.ok(update.position>=update.bounds.min&&update.position<=update.bounds.max);
    if(update.waypoint!==previousWaypoint){stops++;previousWaypoint=update.waypoint;}
    if(update.action&&update.action.startedAt!==previousAction){
      if(update.action.kind==='leisure')leisureStarts++;else lightStarts++;
    }
    previousAction=update.action?.startedAt??null;
  }});
  for(let minute=0;minute<360;minute++){
    f.time.advance(60000);assert.equal(f.time.pending(),1);
  }
  assert.equal(f.time.now(),6*60*60*1000);
  assert.ok(f.plan.snapshot().elapsed>3*60*60*1000,'effective route time keeps advancing despite repeated full stretches');
  assert.ok(stops>300,`the production module reached ${stops} stops`);
  assert.ok(leisureStarts>1000);assert.ok(lightStarts>3000);
  assert.equal(f.updates.length,0,'the soak fixture does not accumulate every emitted snapshot');
  assert.equal(f.plan.snapshot().active,true);
  t.diagnostic(JSON.stringify({wallMs:f.time.now(),effectiveMs:f.plan.snapshot().elapsed,stops,leisureStarts,lightStarts,pendingTimers:f.time.pending()}));
});

test('late timers discard missed beats and do not replay them on later ticks',t=>{
  const f=fixture(t),{time,plan}=f;
  time.jump(4000);near(plan.snapshot().elapsed,4000);assert.equal(plan.snapshot().action,null,'missed 3s blink is discarded');
  time.jump(6500);near(plan.snapshot().elapsed,10500);near(plan.snapshot().position,68.75);assert.equal(plan.snapshot().action,null,'missed 6s, 9s, 10s events are discarded');
  time.advance(100);assert.equal(plan.snapshot().action,null);near(plan.snapshot().elapsed,10600);
  const next=advanceElapsed(f,12000);assert.equal(next.action.kind,'light','a future on-time beat still runs');
});

test('pause clears timers and a resumed plan starts new beats instead of replaying interrupted leisure',t=>{
  const f=fixture(t),{time,plan,updates}=f;
  advanceElapsed(f,10000);assert.equal(plan.snapshot().action.kind,'leisure');plan.pause();
  assert.equal(time.pending(),0);const count=updates.length;time.advance(90000);assert.equal(updates.length,count);
  plan.resume();near(plan.snapshot().elapsed,0);assert.equal(plan.snapshot().action,null);
  time.advance(2950);assert.equal(plan.snapshot().action,null);time.advance(50);assert.equal(plan.snapshot().action.kind,'light');
});

test('resizing clamps the complete range and a stationary narrow fallback never drifts',t=>{
  const f=fixture(t),{plan,updates}=f;
  advanceElapsed(f,9000);const before=plan.pause();plan.resume({min:150,max:450},before);near(plan.snapshot().position,150);
  const moving=updates.length;advanceElapsed(f,90000);assert.ok(updates.slice(moving).every(update=>update.position>=update.bounds.min&&update.position<=update.bounds.max));
  plan.pause();plan.resume({min:10,max:90,canRoam:false},45);
  const stationary=updates.length;advanceElapsed(f,180000);
  for(const update of updates.slice(stationary)){near(update.position,45);assert.equal(update.phase,'rest');}
});

test('a long stationary narrow period preserves the next waypoint when space returns',t=>{
  const f=fixture(t),{plan}=f;
  plan.pause();plan.resume({min:0,max:300,canRoam:false},0);
  advanceElapsed(f,65000);assert.equal(plan.snapshot().waypoint,0);near(plan.snapshot().position,0);
  plan.pause();plan.resume({min:0,max:300},0);assert.equal(plan.snapshot().target,100);
  advanceElapsed(f,9000);near(plan.snapshot().position,50);
});

test('a changed safe gap skips nearly coincident next stops',t=>{
  const f=fixture(t),{plan}=f;
  plan.pause();plan.resume({min:490.5,max:789.5},589.84375);
  assert.equal(plan.snapshot().waypoint,1);near(plan.snapshot().target,689.8333333333334);assert.equal(plan.snapshot().direction,1);
  advanceElapsed(f,5000);near(plan.snapshot().position,589.84375);assert.equal(plan.snapshot().phase,'walk');
  advanceElapsed(f,9000);near(plan.snapshot().position,(589.84375+689.8333333333334)/2);
});

test('resuming near either end turns toward the next meaningful stop',t=>{
  const right=fixture(t);right.plan.pause();right.plan.resume({min:0,max:300},299);
  assert.equal(right.plan.snapshot().waypoint,3);assert.equal(right.plan.snapshot().target,200);assert.equal(right.plan.snapshot().direction,-1);
  advanceElapsed(right,9000);near(right.plan.snapshot().position,249.5);
  const left=fixture(t);advanceElapsed(left,133000);assert.equal(left.plan.snapshot().waypoint,5);
  left.plan.pause();left.plan.resume({min:0,max:300},.5);
  assert.equal(left.plan.snapshot().waypoint,0);assert.equal(left.plan.snapshot().target,100);assert.equal(left.plan.snapshot().direction,1);
});

test('the minimum useful resumed movement scales down for narrow valid gaps',t=>{
  const f=fixture(t),{plan}=f;plan.pause();plan.resume({min:10,max:22},13.99);
  assert.equal(plan.snapshot().waypoint,1);assert.equal(plan.snapshot().target,18);assert.equal(plan.snapshot().direction,1);
  advanceElapsed(f,9000);assert.equal(plan.snapshot().phase,'walk');near(plan.snapshot().position,15.995);
});

test('changed bounds preserve route direction until an endpoint',t=>{
  const right=fixture(t);right.plan.pause();right.plan.resume({min:0,max:1200},750);
  assert.equal(right.plan.snapshot().target,1200);assert.equal(right.plan.snapshot().direction,1);
  const left=fixture(t);advanceElapsed(left,73000);left.plan.pause();left.plan.resume({min:0,max:1200},400);
  assert.equal(left.plan.snapshot().target,0);assert.equal(left.plan.snapshot().direction,-1);
});

test('resume without an explicit position preserves movement between timer samples',t=>{
  const f=fixture(t),{time,plan}=f;advanceElapsed(f,7000);time.advance(25);near(plan.snapshot().position,25);
  plan.resume();near(plan.snapshot().position,25.3125);near(plan.snapshot().elapsed,0);
});

test('visibility suspension preserves initial waiting progress and shifts its real anchor',t=>{
  const f=fixture(t),{time,plan}=f;time.advance(2000);const before=plan.snapshot();near(plan.suspend(),0);
  assert.equal(plan.snapshot().suspended,true);assert.equal(time.pending(),0);time.advance(60000);assert.equal(plan.resumeSuspended(),true);
  near(plan.snapshot().elapsed,2000);assert.equal(plan.snapshot().epoch,60000);near(plan.snapshot().segmentAt,before.segmentAt+60000);
  advanceElapsed(f,4950);assert.equal(plan.snapshot().phase,'rest');advanceElapsed(f,5000);assert.equal(plan.snapshot().phase,'walk');
});

test('visibility suspension in a walk preserves the exact position and remaining effective movement',t=>{
  const f=fixture(t),{time,plan}=f;advanceElapsed(f,7000);time.advance(25);near(plan.suspend(),25.3125);
  const before=plan.snapshot();time.advance(45000);assert.equal(plan.resumeSuspended(),true);
  near(plan.snapshot().position,before.position);near(plan.snapshot().elapsed,7025);assert.equal(plan.snapshot().phase,'walk');
  assert.equal(plan.snapshot().waypoint,before.waypoint);assert.equal(plan.snapshot().target,before.target);
  advanceElapsed(f,12975);assert.equal(plan.snapshot().phase,'walk');
  // The suspension sampled between timer ticks, so subsequent 50ms samples
  // land at effective x025/x075 rather than exactly on the route boundary.
  advanceElapsed(f,13025);near(plan.snapshot().position,100);assert.equal(plan.snapshot().phase,'rest');
});

test('hidden full actions are discarded without charging their duration or replaying the spent beat',t=>{
  const f=fixture(t,{random:choose('stretch-full')}),{time,plan}=f;advanceElapsed(f,10000);time.advance(500);
  const before=plan.snapshot();plan.suspend();time.advance(60000);assert.equal(plan.resumeSuspended(),true);
  assert.equal(plan.snapshot().action,null);near(plan.snapshot().elapsed,10000);near(plan.snapshot().position,before.position);
  near(plan.snapshot().segmentAt,before.segmentAt+60000);time.advance(50);assert.equal(plan.snapshot().action,null);near(plan.snapshot().elapsed,10050);
  assert.equal(advanceElapsed(f,12000).action.kind,'light');
});

test('repeated hiding retains the original checkpoint and a restored timer has one owner',t=>{
  const f=fixture(t),{time,plan}=f;time.advance(2000);plan.suspend();time.advance(20000);plan.suspend();time.advance(30000);plan.suspend();
  assert.equal(time.pending(),0);assert.equal(plan.resumeSuspended(),true);assert.equal(plan.snapshot().epoch,50000);
  assert.equal(time.pending(),1);assert.equal(plan.resumeSuspended(),false);assert.equal(time.pending(),1);
  advanceElapsed(f,5000);assert.equal(plan.snapshot().phase,'walk');
});

test('a task pause while hidden discards the visibility checkpoint and uses the ordinary reset',t=>{
  const f=fixture(t),{time,plan}=f;time.advance(2000);plan.suspend();time.advance(5000);plan.pause();
  assert.equal(plan.snapshot().suspended,false);assert.equal(plan.resumeSuspended(),false);time.advance(10000);plan.resume();near(plan.snapshot().elapsed,0);
  advanceElapsed(f,4950);assert.equal(plan.snapshot().phase,'rest');advanceElapsed(f,5000);assert.equal(plan.snapshot().phase,'walk');
});

test('a hidden light gesture is discarded and later beats retain their accumulated progress',t=>{
  const f=fixture(t),{time,plan}=f;time.advance(3700);assert.equal(plan.snapshot().action.kind,'light');near(plan.snapshot().elapsed,3000);plan.suspend();
  time.advance(90000);plan.resumeSuspended();assert.equal(plan.snapshot().action,null);time.advance(50);assert.equal(plan.snapshot().action,null);
  const next=advanceElapsed(f,6000);assert.equal(next.action.name,'ear');assert.equal(next.phase,'walk');
});

test('visibility suspension at time zero is recoverable and destruction removes the checkpoint',t=>{
  const {time,plan}=fixture(t);plan.suspend();time.advance(30000);assert.equal(plan.resumeSuspended(),true);
  plan.suspend();plan.destroy();assert.equal(plan.resumeSuspended(),false);assert.equal(plan.snapshot().suspended,false);assert.equal(time.pending(),0);
});

test('a steady route still consumes 180 effective seconds across actions and repeated visibility pauses',t=>{
  const f=fixture(t),{time,plan}=f;advanceElapsed(f,163000);near(plan.snapshot().position,0);
  const start=time.now();let elapsed=163000;
  for(const target of [100,200,300,200,100,0]) {
    advanceElapsed(f,elapsed+10000);plan.suspend();time.advance(60000);plan.resumeSuspended();
    advanceElapsed(f,elapsed+26000);assert.equal(plan.snapshot().phase,'walk');plan.suspend();time.advance(20000);plan.resumeSuspended();
    advanceElapsed(f,elapsed+30000);near(plan.snapshot().position,target);elapsed+=30000;
  }
  near(plan.snapshot().elapsed-163000,180000);assert.ok(time.now()-start>180000+6*80000);
  assert.equal(plan.snapshot().waypoint,0);near(plan.snapshot().position,0);
});

test('destroy and repeated resume leave no orphan timers',t=>{
  const {time,plan}=fixture(t);plan.resume();plan.resume();assert.equal(time.pending(),1);
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

test('task frames and durations match their golden hashes, including the approved happy paw recolor',() => {
  const golden=require('./fixtures/cc-cat-task-frames.json');
  for(const [state,expected] of Object.entries(golden.states)) {
    const animation=cat.ANIMATIONS[state];
    assert.deepEqual(animation,{ duration:expected.duration,frames:expected.frames });
    const frames=Array.from({ length:animation.frames },(_,i) => cat.frameForState(state,(i+1e-6)/animation.frames));
    const hash=createHash('sha256').update(JSON.stringify({ animation,frames })).digest('hex');
    assert.equal(hash,expected.sha256,`${state}: every rendered pixel, pose, expression and frame duration must remain unchanged`);
  }
});
