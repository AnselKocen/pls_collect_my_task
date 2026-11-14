const test=require('node:test');
const assert=require('node:assert/strict');
const {errorMessage,isEmptyDigest,digestText}=require('../public/messages');

test('technical errors and filesystem details stay out of user-facing messages',()=>{
  for(const detail of ['AI 结果校验失败：没有返回有效 JSON，本次结果未保存','spawn /private/example/claude ENOENT','SQLite database disk image is malformed','未知错误 /Users/example/private/memo.sqlite','选定范围没有便签，请调整标签或日期']) {
    const message=errorMessage(detail);
    assert.doesNotMatch(message,/JSON|SQLite|ENOENT|校验|口径|\/private\/|\/Users\//i);
    assert.match(message,/哦|吧/);
  }
  assert.match(errorMessage('选定范围没有便签，请调整标签或日期'),/没有记录.*标签或日期/);
  assert.match(errorMessage('卡池为空'),/添几张卡片/);
  assert.match(errorMessage('authentication required'),/登录/);
});

test('assistant errors use the selected product and task messages omit CC subjects',()=>{
  for(const [id,name] of Object.entries({cc:'Claude Code',codex:'Codex',codebuddy:'CodeBuddy'})) {
    assert.ok(errorMessage('AGENT_CLI_MISSING:'+id).includes(name));
    assert.ok(errorMessage('AGENT_AUTH:'+id).includes(name));
    assert.ok(errorMessage('authentication required',id).includes(name));
  }
  for(const detail of ['CC_BUSY:graph','AI_BUSY:切换','正在处理「生成图谱」','AI 或数据管理任务正在进行']) {
    assert.doesNotMatch(errorMessage(detail),/CC|cc|Claude/);
    assert.match(errorMessage(detail),/上一项任务/);
  }
});

test('legacy empty digest in the screenshot gets a useful, friendly message',()=>{
  const digest={summary:'· 2026年4月21日，暂无记录\n\n· 2026年4月22日，暂无记录'};
  assert.equal(isEmptyDigest(digest),true);
  const message=digestText(digest,{legacy:true});
  assert.match(message,/还没有内容.*重新生成/);
  assert.doesNotMatch(message,/旧版|口径|范围|本地日期/);
});

test('empty daily and weekly digests differ from real prose that mentions an empty day',()=>{
  assert.match(digestText({empty:true,summary:''}),/昨天和今天还没有记录/);
  assert.match(digestText({summary:'本周暂无记录。'},{weekly:true}),/这周还没有记录/);
  assert.match(digestText({empty:true,tags:['创作']},{weekly:true}),/选中的标签/);
  const summary='今天暂无记录，但我还是想把这个想法留着。\n\n昨天去了公园。';
  assert.equal(isEmptyDigest({summary}),false);
  assert.equal(digestText({summary}),summary);
  assert.ok(digestText({summary},{legacy:true}).endsWith(summary));
});
