(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports=factory();
  else root.memoGraphLayout=factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function makeView(entry, collapsed = false) {
    const original=(entry.nodes || []).map(node=>({...node,id:String(node.id),memoIds:[...(node.memoIds || [])]}));
    let clusters=(entry.clusters || []).map(cluster=>({...cluster,memoIds:[...(cluster.memoIds || [])]}));
    if (!clusters.length) {
      const labels=[...new Set(original.map(node=>node.tag || '未分类'))];
      clusters=labels.map(label=>({id:'legacy:'+label,title:label,summary:'',memoIds:[]}));
      original.forEach(node=>{node.clusterId='legacy:'+(node.tag || '未分类');});
    }
    const byId=new Map(original.map(node=>[node.id,node]));
    const groupIds=new Set(clusters.map(cluster=>cluster.id));
    const normalizeId=value=>String(typeof value === 'object' ? value.id : value);
    const edges=(entry.edges || []).map(edge=>({...edge,source:normalizeId(edge.source),target:normalizeId(edge.target)})).filter(edge=>byId.has(edge.source)&&byId.has(edge.target));
    const themes=(entry.clusterEdges || []).filter(edge=>groupIds.has(edge.source)&&groupIds.has(edge.target)).map(edge=>({...edge,kind:'theme'}));
    if (!collapsed) return {nodes:original,edges,clusters,themeEdges:themes,collapsed:false};
    const nodeId=id=>'group:'+id;
    const nodes=clusters.map(cluster=>{
      const members=original.filter(node=>node.clusterId === cluster.id);
      const memoIds=[...new Set(cluster.memoIds.length ? cluster.memoIds : members.flatMap(node=>node.memoIds))];
      return {id:nodeId(cluster.id),clusterId:cluster.id,label:cluster.title,nodeCount:memoIds.length || members.length,memoIds,isCluster:true};
    });
    const combined=new Map();
    function add(source,target,relation) {
      if (!source || !target || source === target)return;
      const key=[source,target].sort().join('\0');
      if(!combined.has(key))combined.set(key,{source:nodeId(source),target:nodeId(target),relation,count:0,kind:'theme'});
      combined.get(key).count++;
    }
    edges.forEach(edge=>add(byId.get(edge.source).clusterId,byId.get(edge.target).clusterId,edge.relation));
    themes.forEach(edge=>add(edge.source,edge.target,edge.relation));
    return {nodes,edges:[...combined.values()],clusters,themeEdges:[],collapsed:true};
  }
  return {makeView};
});
