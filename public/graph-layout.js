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
  // Both character count and measured SVG width matter for mixed Chinese/Latin text.
  function fitLabel(text, maxChars, maxWidth, measure) {
    const characters=Array.from(String(text || ''));
    if(characters.length<=maxChars && measure(characters.join(''))<=maxWidth)return characters.join('');
    let shown=characters.slice(0,maxChars);
    while(shown.length && measure(shown.join('')+'…')>maxWidth)shown.pop();
    return shown.join('')+'…';
  }
  // Separate complete label/circle rectangles, including theme headings. Unlike a
  // circular collision radius this accounts for text extending right of a node.
  function separateLabels(items,width,height,padding=8,passes=20) {
    const clamp=item=>{
      item.x=Math.max(padding-item.left,Math.min(width-padding-item.right,item.x));
      item.y=Math.max(padding-item.top,Math.min(height-padding-item.bottom,item.y));
    };
    items.forEach(clamp);
    for(let pass=0;pass<passes;pass++) {
      let moved=false;
      for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++) {
        const a=items[i],b=items[j];
        const ax=a.x+(a.left+a.right)/2,ay=a.y+(a.top+a.bottom)/2;
        const bx=b.x+(b.left+b.right)/2,by=b.y+(b.top+b.bottom)/2;
        const overlapX=(a.right-a.left+b.right-b.left)/2+padding-Math.abs(ax-bx);
        const overlapY=(a.bottom-a.top+b.bottom-b.top)/2+padding-Math.abs(ay-by);
        if(overlapX<=0 || overlapY<=0)continue;
        const aFixed=a.fx!=null || a.fy!=null,bFixed=b.fx!=null || b.fy!=null;
        if(aFixed&&bFixed)continue;
        const aShare=aFixed ? 0 : bFixed ? 1 : .5,bShare=1-aShare;
        if(overlapX<overlapY) {
          const delta=(ax<=bx ? -1 : 1)*(overlapX+.1);
          a.x+=delta*aShare;b.x-=delta*bShare;
        } else {
          const delta=(ay<=by ? -1 : 1)*(overlapY+.1);
          a.y+=delta*aShare;b.y-=delta*bShare;
        }
        if(!aFixed){a.vx=0;a.vy=0;}if(!bFixed){b.vx=0;b.vy=0;}
        clamp(a);clamp(b);moved=true;
      }
      if(!moved)break;
    }
  }
  return {makeView,fitLabel,separateLabels};
});
