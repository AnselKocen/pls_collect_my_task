function respond(task, input) {
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
