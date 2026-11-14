function respond(task, input) {
  if (task === 'habit-wish-question') return input.stage === 'purpose'
    ? { question: `关于“${input.wish}”，你最希望它给日常生活带来什么样的变化？`, options: ['享受尝试和探索的过程', '让工作学习更顺利一些', '建立稳定的日常节奏'] }
    : { question: `为了“${input.purpose}”，你更希望用怎样的时间和方式来践行？`, options: ['利用零碎时间，每次几分钟', '每天留出十分钟，慢慢积累', '愿意投入更多时间，接受一些挑战'] };
  if (task === 'habit-wish-pool') return { name: '愿望小步走', description: '让愿望一点点融入日常', habits: Array.from({ length: 30 }, (_, i) => '尝试第' + (i + 1) + '个小练习') };
  if(task==='habit-pool')return {name:'日常小事',description:'从书里挑些小习惯',habits:Array.from({length:30},(_,i)=>'试试第'+(i+1)+'个小习惯')};
  if (task === 'graph') {
    const records=[...new Map(input.records.map(record=>[record.id,record])).values()];
    const labels=[...new Set(records.map(record=>record.tags[0] || '独立想法'))];
    const nodes=records.map(record=>({id:record.id,label:record.content || '记录',tag:record.tags[0] || '独立想法',memoIds:[record.id]}));
    const edges=nodes.length>1 ? [{source:nodes[0].id,target:nodes[1].id,relation:'相关想法'}] : [];
    return {nodes,edges,summaries:labels.map(tag=>({tag,summary:'这些记录围绕同一事项，可以放在一起继续想想。'})),insights:'这些想法之间有值得继续探索的联系。'};
  }
  if (task === 'graph-merge') {
    const nodes=new Map(),summaries=new Map(),edges=[];
    for(const graph of input.graphs) {
      graph.nodes.forEach(node=>nodes.set(node.id,node));
      graph.summaries.forEach(item=>summaries.set(item.tag,item));
      edges.push(...graph.edges);
    }
    return {nodes:[...nodes.values()],edges,summaries:[...summaries.values()],insights:input.graphs.map(graph=>graph.insights).join('\n\n')};
  }
  if (task === 'tag-suggestions') {
    const record=input.records.at(-1);
    if (!record)return [];
    const tag=record.tags[0];
    return tag ? [{action:'review',tags:[tag],reason:'检查标签边界。',memoIds:[record.id]}] : [];
  }
  if (task === 'tags-merge') return [...new Map(input.suggestions.map(suggestion=>[suggestion.tags.join(','),suggestion])).values()];
  if (task.endsWith('digest') || task === 'digest-merge') return {summary:'仅总结所提供的范围。',tasks:[],date:'错误的模型日期',week:'错误的模型周编号',tagTrends:{fabricated:999}};
  throw new Error('Unexpected fake task '+task);
}
module.exports={respond};
