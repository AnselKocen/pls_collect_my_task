// Translate public reply events only. Reasoning/thinking and tool payloads stay private.
const CODEX_HTTP_PROVIDER='memo_journal_openai_http';
const CODEX_HTTP_CONFIG=Object.freeze([
  `model_providers.${CODEX_HTTP_PROVIDER}.name="OpenAI HTTP"`,
  `model_providers.${CODEX_HTTP_PROVIDER}.wire_api="responses"`,
  `model_providers.${CODEX_HTTP_PROVIDER}.requires_openai_auth=true`,
  `model_providers.${CODEX_HTTP_PROVIDER}.supports_websockets=false`
]);
function createCodexSession({send,emit,finish,fail,prompt,cwd}) {
  let sequence=0,threadId=null,turnId=null,lastAnswer='';
  const pending=new Map(),answers=new Map();
  function request(method,params) {
    return new Promise((resolve,reject) => {
      const id=++sequence;pending.set(id,{resolve,reject});send({id,method,params});
    });
  }
  async function start() {
    try {
      await request('initialize',{clientInfo:{name:'memo_journal',title:'记忆手帐',version:'1.0.0'},capabilities:{}});
      send({method:'initialized'});
      const result=await request('thread/start',{cwd,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',config:{model_reasoning_effort:'medium'}});
      threadId=result.thread.id;
      emit({type:'stage',label:'正在等待 Codex 回答'});
      const response=await request('turn/start',{threadId,input:[{type:'text',text:prompt,text_elements:[]}],effort:'medium',summary:'none'});
      turnId=response.turn.id;
    } catch(error) {fail(error);}
  }
  function message(row) {
    if (row.id !== undefined && !row.method) {
      const call=pending.get(row.id);if(!call)return;
      pending.delete(row.id);
      row.error ? call.reject(new Error(row.error.message || 'Codex 请求失败')) : call.resolve(row.result);
      return;
    }
    if (row.id !== undefined && row.method) {
      send({id:row.id,error:{code:-32601,message:'This journal task does not support interactive tool requests.'}});
      fail(new Error('本次整理需要交互式操作，请在助手中完成后重试'));return;
    }
    const p=row.params || {};
    if (p.threadId && p.threadId!==threadId) return;
    if (turnId && p.turnId && p.turnId!==turnId) return;
    if (row.method==='item/agentMessage/delta' && typeof p.delta==='string') {
      answers.set(p.itemId,(answers.get(p.itemId) || '')+p.delta);
      emit({type:'delta',messageId:p.itemId,text:p.delta});
    } else if (row.method==='item/completed' && p.item?.type==='agentMessage') {
      const item=p.item;
      answers.set(item.id,item.text || '');
      emit({type:'message',messageId:item.id,text:item.text || '',phase:item.phase==='commentary' ? 'commentary' : 'answer'});
      if(item.phase!=='commentary')lastAnswer=item.text || '';
    } else if (row.method==='error') {
      if(p.willRetry)emit({type:'stage',label:'连接暂时中断，正在重试'});
      else fail(new Error(p.error?.message || 'Codex 调用失败'));
    } else if (row.method==='turn/completed') {
      if(p.turn?.status!=='completed')return fail(new Error(p.turn?.error?.message || 'Codex 任务未完成'));
      const answer=lastAnswer || [...answers.values()].at(-1) || '';
      finish(answer);
    }
  }
  return {start,message};
}

function createPrintSession({emit,finish,fail}) {
  let messageId='reply',lastAnswer='';
  function message(row) {
    if(row.parent_tool_use_id)return;
    if(row.type==='stream_event') {
      const event=row.event || {};
      if(event.type==='message_start')messageId=event.message?.id || messageId;
      const delta=event.type==='content_block_delta' && event.delta;
      if(delta?.type==='text_delta' && typeof delta.text==='string')emit({type:'delta',messageId,text:delta.text});
    } else if(row.type==='assistant') {
      const content=row.message?.content;
      if(!Array.isArray(content))return;
      const text=content.filter(block => block.type==='text').map(block => block.text || '').join('');
      if(text) {
        messageId=row.message.id || messageId;lastAnswer=text;
        emit({type:'message',messageId,text,phase:'answer'});
      }
    } else if(row.type==='system' && row.subtype==='api_retry') {
      emit({type:'stage',label:'连接暂时中断，正在重试'});
    } else if(row.type==='result') {
      if(row.is_error || (row.subtype && row.subtype!=='success')) {
        fail(new Error(row.result || row.errors?.join('; ') || 'AI 调用失败'));return;
      }
      const answer=typeof row.result==='string' ? row.result : row.structured_output ? JSON.stringify(row.structured_output) : lastAnswer;
      if(answer)emit({type:'message',messageId,text:answer,phase:'answer'});
      finish(answer);
    }
  }
  return {start(){},message};
}

module.exports={createCodexSession,createPrintSession,CODEX_HTTP_PROVIDER,CODEX_HTTP_CONFIG};
