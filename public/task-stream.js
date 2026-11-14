(function() {
  const modal=document.getElementById('aiTaskModal'),output=document.getElementById('aiTaskOutput');
  const details=document.getElementById('aiTaskDetailsBtn'),close=document.getElementById('aiTaskClose');
  const titles={cc:'Claude Code',codex:'Codex',codebuddy:'CodeBuddy'};
  let task=null,connected=false,frame=null,previousFocus=null,syncedAt=0,refreshPending=null;
  let streamId=null,revision=-1,updatesReceived=0;
  const retiredStreams=new Set();
  const cards=new Map();
  function formatDuration(ms) {
    const seconds=Math.max(0,Math.floor(ms/1000));
    return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  }
  function render() {
    frame=null;details.disabled=!task;
    document.querySelectorAll('[data-ai-task-details]').forEach(button => {button.hidden=!task;});
    if(modal.classList.contains('hidden') || !task)return;
    document.getElementById('aiTaskTitle').textContent=task.name;
    const status=document.getElementById('aiTaskStatus');status.dataset.status=task.status;
    status.textContent={running:'进行中',completed:'已完成',failed:'未完成'}[task.status] || '等待任务';
    const duration=formatDuration((task.finishedAt || Date.now())-task.startedAt);
    document.getElementById('aiTaskMeta').textContent=(titles[task.agent] || task.agent)+' · 已用 '+duration;
    document.getElementById('aiTaskStage').textContent=task.error || task.stage;
    document.getElementById('aiTaskConnection').textContent=task.status==='running' && !connected
      ? Date.now()-syncedAt<10000 ? '实时连接暂时断开，正在定时同步回答。' : '连接暂时断开，正在重连；后台任务继续运行。'
      : task.truncated ? '较早的输出已省略，当前显示最近的回答。' : '';
    const atEnd=output.scrollHeight-output.scrollTop-output.clientHeight<50;
    const ids=new Set(task.messages.map(message => message.id));
    for(const [id,card] of cards)if(!ids.has(id)){card.remove();cards.delete(id);}
    output.querySelector('.ai-task-empty')?.remove();
    if(!task.messages.length) {
      const empty=document.createElement('p');empty.className='ai-task-empty';
      empty.textContent=task.status==='running' ? '正在等待回答，收到文字后会实时显示在这里。' : task.status==='completed' ? '本次任务已完成，没有产生模型文字输出。' : '本次没有收到回答，请查看上方提示。';
      output.append(empty);
    }
    for(const message of task.messages) {
      let card=cards.get(message.id);
      if(!card) {
        card=document.createElement('section');card.className='ai-task-message';
        card.append(document.createElement('div'),document.createElement('pre'));cards.set(message.id,card);output.append(card);
      }
      card.firstChild.textContent=(message.phase==='commentary' ? '任务说明' : '回答')+' · '+message.stage;
      card.lastChild.textContent=message.text;
    }
    if(atEnd)output.scrollTop=output.scrollHeight;
  }
  function schedule() {if(frame===null)frame=requestAnimationFrame(render);}
  window.openAITaskDetails=function() {
    void refresh();
    if(!task)return;
    previousFocus=document.activeElement;modal.classList.remove('hidden');render();close.focus();
  };
  function hide() {modal.classList.add('hidden');previousFocus?.focus();}
  close.addEventListener('click',hide);
  details.addEventListener('click',window.openAITaskDetails);
  modal.addEventListener('click',event => {if(event.target===modal)hide();});
  modal.addEventListener('keydown',event => {
    if(event.key==='Escape'){event.stopPropagation();hide();}
    if(event.key==='Tab') {
      const first=close,last=output;
      if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
    }
  });
  document.getElementById('ccTaskBubble').addEventListener('click',event => {
    if(event.target.closest('[data-ai-task-details]')){event.stopPropagation();window.openAITaskDetails();}
  });
  // Keep a reachable entry inside feature dialogs while their backdrops cover the mascot.
  for(const id of ['digestRegenBtn','tagSuggestGenBtn','graphRegenBtn','weeklyGenBtn','habitUploadProgress']) {
    const anchor=document.getElementById(id);if(!anchor)continue;
    const button=document.createElement('button');button.type='button';button.className='btn-small ai-task-inline';
    button.dataset.aiTaskDetails='';button.textContent='查看任务详情';button.hidden=true;
    button.addEventListener('click',window.openAITaskDetails);anchor.after(button);
  }
  function applyUpdate(update) {
    if(!['snapshot','delta'].includes(update.type))return;
    if(update.type==='delta' && task?.id!==update.taskId){void refresh();return;}
    // Poll responses and buffered stream events can arrive out of order.
    if(typeof update.streamId==='string' && Number.isSafeInteger(update.revision)) {
      if(retiredStreams.has(update.streamId))return;
      if(streamId===update.streamId && update.revision<=revision)return;
      if(update.type==='delta' && (streamId!==update.streamId || update.revision!==revision+1)) {
        void refresh();return;
      }
      if(streamId!==update.streamId) {
        if(streamId)retiredStreams.add(streamId);
        streamId=update.streamId;
      }
      revision=update.revision;
    }
    if(update.type==='snapshot') {
      task=update.task;
      if(!task && !modal.classList.contains('hidden'))hide();
    } else if(update.type==='delta' && task?.id===update.taskId) {
      let message=task.messages.find(item => item.id===update.message.id);
      if(!message){message={...update.message,text:''};task.messages.push(message);}
      message.text+=update.text;
    }
    ++updatesReceived;
    schedule();
  }
  function refresh() {
    if(refreshPending)return refreshPending;
    const version=updatesReceived,controller=new AbortController();
    const timeout=setTimeout(() => controller.abort(),6000);
    refreshPending=(async () => {
      try {
        const response=await fetch('/api/ai/task',{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error('Task status unavailable');
        const update=await response.json();
        // Compatibility with a server still running the previous protocol.
        if(!Number.isSafeInteger(update.revision) && version!==updatesReceived)return;
        applyUpdate({...update,type:'snapshot'});syncedAt=Date.now();schedule();
      } catch { schedule(); }
      finally {clearTimeout(timeout);refreshPending=null;}
    })();
    return refreshPending;
  }
  try {
    const source=new EventSource('/api/ai/events');
    source.onopen=() => {connected=true;void refresh();schedule();};
    source.onerror=() => {connected=false;void refresh();schedule();};
    source.addEventListener('task',event => {
      let update;try{update=JSON.parse(event.data);}catch{return;}
      applyUpdate(update);
    });
  } catch { /* Snapshot polling also works when streaming is unavailable. */ }
  void refresh();
  setInterval(() => {if(!document.hidden)void refresh();},2000);
  window.addEventListener('focus',() => {void refresh();});
  document.addEventListener('visibilitychange',() => {if(!document.hidden)void refresh();});
  setInterval(() => {if(!modal.classList.contains('hidden'))schedule();},1000);
})();
