// Explicit acceptance run. Every model invocation in these tests uses a fake CLI.
// This is not evidence of real Claude Code/model quality or authentication.
const fs=require('node:fs'),path=require('node:path');
const {run}=require('node:test');
const project=path.resolve(__dirname,'..');
const output=path.join(__dirname,'acceptance-evidence','simulation');
fs.mkdirSync(output,{recursive:true});
const files=fs.readdirSync(__dirname).filter(name=>name.endsWith('.test.js')).sort().map(name=>path.join(__dirname,name));
const startedAt=new Date().toISOString();
const events=[],cases=[];let lastSummary;
const serializeError=error=>error && ({message:error.message,code:error.code,failureType:error.failureType,stack:error.stack});
const stream=run({files,concurrency:true});
stream.on('data',event=>{
  const {type,data}=event;
  if(type==='test:pass' || type==='test:fail') {
    const row={status:type==='test:pass' ? 'passed' : 'failed',name:data.name,file:path.relative(project,data.file || ''),line:data.line,nesting:data.nesting,durationMs:data.details?.duration_ms,skip:data.skip,todo:data.todo,error:serializeError(data.details?.error)};
    cases.push(row);
    console.log((row.status==='passed' ? 'PASS' : 'FAIL')+' '+row.file+': '+row.name);
    events.push({type,...row});
  } else if(type==='test:summary') {
    lastSummary=data;
    events.push({type,...data});
  } else if(type==='test:stdout' || type==='test:stderr' || type==='test:diagnostic') {
    events.push({type,...data});
  }
});
stream.on('error',error=>{console.error(error.stack);process.exitCode=1;});
stream.on('end',()=>{
  const finishedAt=new Date().toISOString();
  const summary={mode:'simulation',actualClaudeCode:false,actualModelCalls:false,scope:'All existing *.test.js suites; isolated temporary databases and fake CLI processes',startedAt,finishedAt,node:process.version,testFiles:files.map(file=>path.relative(project,file)),summary:lastSummary,cases};
  fs.writeFileSync(path.join(output,'suite-events.jsonl'),events.map(event=>JSON.stringify(event)).join('\n')+'\n');
  fs.writeFileSync(path.join(output,'suite-result.json'),JSON.stringify(summary,null,2)+'\n');
  const failed=cases.filter(row=>row.status==='failed');
  if(failed.length || lastSummary?.success===false)process.exitCode=1;
  console.log(JSON.stringify({simulationAcceptance:true,passed:cases.filter(row=>row.status==='passed').length,failed:failed.length,summary:lastSummary,report:path.join(output,'suite-result.json')}));
});
