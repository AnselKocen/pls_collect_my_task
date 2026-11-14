// Test-only instrumentation: expose scheduled callbacks over the child IPC
// channel without changing the machine clock or production scheduler.
const cron=require('node-cron');
const schedule=cron.schedule.bind(cron),jobs=[];
cron.schedule=(expression,callback,...options)=>{
  const task=schedule(expression,callback,...options),job={expression,callback,active:true};
  const stop=task.stop.bind(task);
  task.stop=()=>{job.active=false;return stop();};jobs.push(job);return task;
};
const interval=setInterval;let reminder;
global.setInterval=(callback,milliseconds,...args)=>{
  if(milliseconds===15000){reminder=callback;return interval(()=>{},milliseconds);}
  return interval(callback,milliseconds,...args);
};
process.on('message',async({id,action,index,now})=>{
  const OriginalDate=Date;
  try {
    if(now)global.Date=class extends OriginalDate {
      constructor(...args){super(...(args.length ? args : [now]));}
      static now(){return OriginalDate.parse(now);}
    };
    let result;
    if(action==='jobs')result=jobs.filter(job=>job.active).map(job=>job.expression);
    else if(action==='run')await jobs.filter(job=>job.active)[index].callback();
    else if(action==='reminder')reminder();
    else throw new Error('Unknown test action');
    process.send({id,result,ok:true});
  } catch(error) {process.send({id,ok:false,error:error.message});}
  finally {global.Date=OriginalDate;}
});
