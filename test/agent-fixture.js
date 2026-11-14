const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'memo-agent-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const capture = path.join(dir,'calls.jsonl'), mode = path.join(dir,'mode');
  const env = {...process.env,MEMO_CONFIG_DIR:dir,MEMO_FAKE_CC_CAPTURE:capture,MEMO_FAKE_CC_INVALID_FILE:mode};
  const quote = value => "'"+value.replace(/'/g,"'\\''")+"'";
  for (const [id,key] of Object.entries({cc:'CLAUDE_CLI',codex:'CODEX_CLI',codebuddy:'CODEBUDDY_CLI'})) {
    const file = path.join(dir,id+(process.platform === 'win32' ? '.cmd' : ''));
    const cli = path.join(__dirname,'fake-model-cli.js');
    fs.writeFileSync(file,process.platform === 'win32'
      ? `@echo off\r\nset MEMO_FAKE_AGENT=${id}\r\n"${process.execPath}" "${cli}" %*\r\n`
      : `#!/bin/sh\nexport MEMO_FAKE_AGENT=${id}\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,{mode:0o755});
    env[key]=file;
  }
  return {dir,capture,mode,env};
}

module.exports = {fixture};
