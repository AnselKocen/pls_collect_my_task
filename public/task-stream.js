(function() {
  let task=null,refreshPending=null,frame=null,pending=null,localResult=null;
  let streamId=null,revision=-1,updatesReceived=0;
  const retiredStreams=new Set();
  const viewedPoolIds=new Set();
  const resultTypes=new Set(['weekly-digest','tag-suggestions','graph','habit-wish','habit-pool']);
  const sameKind=(a,b)=>a?.type===b?.type && (!a?.source || !b?.source || a.source===b.source)
    && (a?.type!=='habit-wish' || !a.step || !b.step || a.step===b.step);
  const destinationTask=()=>pending ? pending.result : localResult || task;
  const canView=current=>current?.status==='completed' && resultTypes.has(current.target?.type)
    && !(current.target.type==='habit-pool' && viewedPoolIds.has(current.target.id));
  function render() {
    frame=null;
    const current=destinationTask();
    const viewedPool=current?.status==='completed' && current.target?.type==='habit-pool' && viewedPoolIds.has(current.target.id);
    document.querySelectorAll('[data-ai-task-details]').forEach(button=>{
      const target=pending?.target || current?.target;
      button.textContent='前往查看';button.hidden=!canView(current)
        || Boolean(button.dataset.aiTaskType && button.dataset.aiTaskType!==target?.type);
      button.disabled=button.hidden;
      button.title='前往本次任务所在位置';
    });
    if(viewedPool){
      const bubble=document.getElementById('ccTaskBubble');
      if(bubble && !bubble.classList.contains('hidden'))bubble.querySelector('#ccBubbleClose')?.click();
    }
  }
  function schedule(){if(frame===null)frame=requestAnimationFrame(render);}
  window.updateAITaskNavigation=render;
  window.markAITaskDestinationViewed=poolId=>{
    if(typeof poolId==='string' && poolId){viewedPoolIds.add(poolId);render();}
  };
  window.getCurrentAITask=()=>task;
  window.markAITaskPending=(target,key)=>{
    pending={target,key,previousId:task?.id,result:null};localResult=null;render();
  };
  window.setAITaskNavigationResult=(key,target)=>{
    const result={id:task?.id,name:key,status:'completed',target};
    if(pending?.key===key)pending.result=result;
    else if(!pending && sameKind(task?.target,target))localResult=result;
    render();
  };
  window.finishAITaskPending=(key,success)=>{
    if(pending?.key===key && !pending.result)pending.result={name:key,status:success?'completed':'failed',target:pending.target};
    render();void refresh();
  };
  window.openAITaskDestination=function(explicitTask){
    // A recheck must never delay a click behind a stalled network request.
    const current=explicitTask?.target ? explicitTask : destinationTask();
    void refresh();
    if(!canView(current))return Promise.resolve(false);
    return Promise.resolve(window.navigateToAITaskResult?.(current));
  };
  window.openAITaskDetails=window.openAITaskDestination;
  document.getElementById('ccTaskBubble')?.addEventListener('click',event=>{
    if(event.target.closest('[data-ai-task-details]')){event.stopPropagation();void window.openAITaskDestination();}
  });
  const entries={tagSuggestGenBtn:'tag-suggestions',graphRegenBtn:'graph',weeklyGenBtn:'weekly-digest',habitUploadProgress:'habit-pool'};
  for(const [id,type] of Object.entries(entries)){
    const anchor=document.getElementById(id);if(!anchor)continue;
    const button=document.createElement('button');button.type='button';button.className='btn-small ai-task-inline';
    button.dataset.aiTaskDetails='';button.dataset.aiTaskType=type;button.textContent='前往查看';button.hidden=true;
    button.addEventListener('click',()=>{void window.openAITaskDestination();});anchor.after(button);
  }
  function applyUpdate(update){
    if(!['snapshot','delta'].includes(update.type))return;
    if(update.type==='delta' && task?.id!==update.taskId){void refresh();return;}
    if(typeof update.streamId==='string' && Number.isSafeInteger(update.revision)){
      if(retiredStreams.has(update.streamId))return;
      if(streamId===update.streamId && update.revision<=revision)return;
      if(update.type==='delta' && (streamId!==update.streamId || update.revision!==revision+1)){void refresh();return;}
      if(streamId!==update.streamId){if(streamId)retiredStreams.add(streamId);streamId=update.streamId;}
      revision=update.revision;
    }
    if(update.type==='snapshot'){
      task=update.task;
      if(pending && task?.id!==pending.previousId && (pending.target ? sameKind(task?.target,pending.target) : Boolean(task?.target)))pending=null;
      if(localResult && (!task || task.id!==localResult.id || task.status!=='running'))localResult=null;
    }else if(update.type==='delta' && task?.id===update.taskId){
      const messages=task.messages || (task.messages=[]);
      let message=messages.find(item=>item.id===update.message.id);
      if(!message){message={...update.message,text:''};messages.push(message);}
      message.text+=update.text;
    }
    ++updatesReceived;
    // Preserve the authoritative task and mascot sync without another viewer.
    window._ccLatestTask=task;
    window.dispatchEvent(new CustomEvent('cc-task-update',{detail:{task}}));
    schedule();
  }
  function refresh(){
    if(refreshPending)return refreshPending;
    const version=updatesReceived,controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),6000);
    refreshPending=(async()=>{
      try{
        const response=await fetch('/api/ai/task',{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error('Task status unavailable');
        const update=await response.json();
        if(!Number.isSafeInteger(update.revision) && version!==updatesReceived)return;
        applyUpdate({...update,type:'snapshot'});
      }catch{/* Keep the known task reachable while reconnecting. */}
      finally{clearTimeout(timeout);refreshPending=null;schedule();}
      return task;
    })();
    return refreshPending;
  }
  window.refreshCurrentAITask=refresh;
  try{
    const source=new EventSource('/api/ai/events');
    source.onopen=()=>{void refresh();};source.onerror=()=>{void refresh();};
    source.addEventListener('task',event=>{let update;try{update=JSON.parse(event.data);}catch{return;}applyUpdate(update);});
  }catch{/* Snapshot polling also works without EventSource. */}
  void refresh();
  setInterval(()=>{if(!document.hidden)void refresh();},2000);
  window.addEventListener('focus',()=>{void refresh();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
})();
