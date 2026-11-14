(function(root,factory) {
  if(typeof module==='object' && module.exports)module.exports=factory();
  else root.memoMessages=factory();
})(typeof globalThis!=='undefined' ? globalThis : this,function() {
  function errorMessage(detail,agent = 'cc') {
    const names = {cc:'Claude Code',codex:'Codex',codebuddy:'CodeBuddy'};
    const marked = String(detail || '').match(/AGENT_(?:CLI_MISSING|AUTH):(cc|codex|codebuddy)(?:$|\s)/)?.[1];
    const name = names[marked || agent] || '所选 AI 助手';
    const value=String(detail || '');
    const rules=[
      [/无效的 AI 助手/,'请选择 cc、codex 或 codebuddy 哦～'],
      [/AI 助手已切换/,'助手已在另一个窗口切换，请再试一次吧～'],
      [/请在这台电脑上配置 AI/,'请在这台电脑上配置 AI 助手哦～'],
      [/选定范围没有便签/,'这里还没有记录哦～换个标签或日期试试吧～'],
      [/AI_BUSY|CC_BUSY|CC正在忙|正在处理「|AI 或数据管理任务正在进行/,'正在处理上一项任务，请稍等～'],
      [/正在恢复数据/,'正在找回你的记录哦～稍等一下再操作吧～'],
      [/数据库正在初始化/,'正在准备你的手帐哦～稍等一下吧～'],
      [/范围过大|无法组织分析输入/,'这次要整理的内容有点多哦～少选一些标签或缩短日期范围，再试试吧～'],
      [/开始日期不能晚于/,'日期好像选反了哦～请把开始日期选在结束日期前面吧～'],
      [/日期不存在|日期需要|查询日期无效|提醒日期/,'这个日期好像不太对哦～请重新选一下吧～'],
      [/时间格式|时间和内容不能为空/,'提醒还没填好哦～请选好时间，再写一句提醒内容吧～'],
      [/内容不能为空/,'还没写内容哦～随手记下一句再保存吧～'],
      [/标签不能为空|^empty$/,'还没填标签名哦～写个名字再保存吧～'],
      [/^exists$/,'这个标签已经有了哦～换个名字试试吧～'],
      [/请选择卡池/,'还没选卡池哦～先选一个再抽卡吧～'],
      [/卡池不存在/,'这个卡池找不到了哦～请重新选一个吧～'],
      [/卡池为空/,'这个卡池里还没有习惯哦～先添几张卡片再来抽吧～'],
      [/请上传ZIP文件/,'还没选好文件哦～请上传一本书的 ZIP 文件吧～'],
      [/ZIP中没有找到可读的文本文件/,'文件里没有找到能读的文字哦～换一本带有文字的书试试吧～'],
      [/请选择数据库备份|请选择一种恢复方式/,'还没选好备份哦～请选择一份备份文件再继续吧～'],
      [/备份不存在/,'这份备份找不到了哦～请刷新列表，重新选一份吧～'],
      [/100 MB/,'这份备份有点大哦～请选择 100 MB 以内的文件吧～'],
      [/备份|SQLite|sqlite|database|数据库完整性/i,'这份备份暂时打不开哦～请换一份记忆手帐的备份文件试试吧～'],
      [/数据管理仅允许|来源标记/,'请在这台电脑上打开记忆手帐，再试一次哦～'],
      [/AGENT_CLI_MISSING|ENOENT|未安装|not found/i,`还没连上 ${name} 哦～请先确认已安装并登录，再试一次吧～`],
      [/AGENT_AUTH|登录|authentication|unauthorized|login/i,`请先登录 ${name}，再试一次吧～`],
      [/超时|timeout|SIGTERM|code null/i,'这次整理花的时间有点长哦～稍后再试一次吧～'],
      [/未找到|记录不存在/,'这条记录找不到了哦～请刷新后再看看吧～'],
      [/搜索内容不能超过/,'搜索词有点长哦～换几个短一点的关键词试试吧～'],
      [/AI 结果校验|JSON|图谱结果没有节点|AI返回格式错误|CC返回格式错误|没有生成可用的习惯/,'这次没整理好哦～请再试一次吧～']
    ];
    return rules.find(([pattern])=>pattern.test(value))?.[1] || '刚才没成功哦～请稍后再试一次吧～';
  }

  function isEmptyDigest(digest) {
    if(digest.empty===true)return true;
    const lines=String(digest.summary || '').split('\n').map(line=>line.trim()).filter(Boolean);
    return lines.length>0 && lines.every(line=>{
      const content=line.replace(/^[·•-]\s*/,'').replace(/^\d{4}(?:-\d{1,2}-\d{1,2}|年\d{1,2}月\d{1,2}日)[，,:：\s]*/,'');
      return /^(?:(?:今日|今天|昨日|昨天|本周|这周)[，,:：\s]*)?(?:暂无记录|没有记录)[。！!～~]?$/.test(content);
    });
  }

  function digestText(digest,{legacy=false,weekly=false}={}) {
    if(isEmptyDigest(digest)) {
      if(legacy)return '这份摘要里还没有内容哦～点一下「重新生成」，整理最近的记录吧～';
      if(weekly)return digest.tags?.length ? '选中的标签这周还没有记录哦～换个标签，或先随手记几句吧～' : '这周还没有记录哦～先随手记几句，再来看看这一周吧～';
      return '昨天和今天还没有记录哦～先随手记几句，再点「重新生成」看看吧～';
    }
    const summary=String(digest.summary || '');
    return (legacy ? '这是之前留下的摘要哦～想看看最近的记录，可以点一下「重新生成」哦～\n\n' : '')+summary;
  }
  return {errorMessage,isEmptyDigest,digestText};
});
