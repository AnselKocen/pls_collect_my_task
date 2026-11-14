// Explicit manual test: sends only these fictional records to the user's Codex CLI.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {invokeAgent}=require('../agents');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'memo-codex-stream-live-'));
const prompt='This is a synthetic integration test. Do not read files or call tools. Return only a JSON array of one tag suggestion for these fictional labels: "reading" and "books". The fictional note is "read a book", ID "fictional-1". Required fields: action "merge", tags ["reading","books"], reason (a short explanation), memoIds ["fictional-1"].';
const started=Date.now();let deltas=0,firstDeltaMs=null;
invokeAgent('codex',prompt,{cwd:folder,timeoutMs:180000,onEvent(event) {
  if(event.type==='delta') {
    deltas++;
    if(firstDeltaMs===null){firstDeltaMs=Date.now()-started;console.log(JSON.stringify({firstTextDeltaMs:firstDeltaMs}));}
  }
}}).then(raw => {
  const result=JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
  assert.ok(deltas>0,'Expected real text deltas before task completion');
  assert.equal(result[0].action,'merge');assert.deepEqual(result[0].memoIds,['fictional-1']);
  console.log(JSON.stringify({realCodexStream:true,deltaCount:deltas,firstDeltaMs,elapsedMs:Date.now()-started,validFinalJSON:true}));
}).catch(error => {console.error(error.stack);process.exitCode=1;}).finally(() => fs.rmSync(folder,{recursive:true,force:true}));
