(function (global) {
  'use strict';

  // Preview-only alternatives. The main cat renderer and its walk stay untouched.
  const cat = global.CCPixelCat || (typeof require === 'function' ? require('./cc-cat') : null);
  const duration = 1120, frames = 8;
  const variants = ['low','raised'];
  const cache = new Map();

  function frameForVariant(variant, progress = 0) {
    const name = variants.includes(variant) ? variant : 'low';
    const t = Number.isFinite(progress) ? ((progress % 1)+1)%1 : 0;
    const index = Math.min(frames-1,Math.floor(t*frames));
    const key = name+':'+index;
    if (cache.has(key)) return cache.get(key);
    const raised = name === 'raised';
    const pose = { headY:raised ? -1 : 0 };
    const parts = cat.createParts(pose);
    const masks = {};
    for (const part of ['body','tail','tail-tip','paw-left','paw-right','foot-left','foot-right']) masks[part] = new Map();
    const dot = (part,x,y,color) => masks[part].set(`${x},${y}`,{ x,y,color });
    const run = (part,y,left,right,color) => { for (let x=left;x<=right;x++) dot(part,x,y,color); };
    function shape(part,rows,fill) {
      const occupied = new Set();
      for (const [y,l,r] of rows) for (let x=l;x<=r;x++) occupied.add(`${x},${y}`);
      for (const point of occupied) {
        const [x,y] = point.split(',').map(Number);
        const edge = [[-1,0],[1,0],[0,-1],[0,1]].some(([dx,dy]) => !occupied.has(`${x+dx},${y+dy}`));
        dot(part,x,y,edge ? 'o' : fill);
      }
    }
    const rows = raised
      ? [[7,14,18],[8,11,20],[9,8,21],[10,5,22],[11,3,22],[12,3,22],[13,4,21],[14,5,8],[14,18,20]]
      : [[8,14,17],[9,10,19],[10,5,20],[11,3,21],[12,2,22],[13,2,22],[14,3,22],[15,4,8],[15,18,21]];
    shape('body',rows,'f');
    for (const pixel of masks.body.values()) {
      if (pixel.color==='o') continue;
      if (pixel.x<=13 && pixel.y>=10) pixel.color='c';
      if (pixel.x>=18 && pixel.y>=9 && pixel.y<=12) pixel.color='m';
    }
    // Both alternatives keep the short side tail and the approved round body.
    const tailLift = raised ? 1 : 0;
    shape('tail-tip',[[13-tailLift,23,26],[14-tailLift,22,27],[15-tailLift,22,26]],'t');
    run('tail',13-tailLift,21,23,'o'); run('tail',14-tailLift,21,23,'f'); run('tail',15-tailLift,21,23,'o');

    const steps = [[-2,0],[-1,0],[1,0],[2,0],[2,1],[0,raised ? 2 : 1],[-2,raised ? 2 : 1],[-2,0]];
    const root = raised ? 12 : 13;
    for (const [part,base,phase,width,color] of [
      ['paw-left',5,0,4,'c'], ['paw-right',9,4,3,'s'],
      ['foot-left',16,6,3,'s'], ['foot-right',19,2,4,'f']
    ]) {
      const [reach,lift] = steps[(index+phase)%frames];
      const floor = 16-lift, toe = base+reach;
      // Fur at the joint blends with the body; only the little toe has an outline.
      for (let y=root;y<floor;y++) {
        const x = y===root ? base : toe;
        run(part,y,x,x+width-1,color);
      }
      run(part,floor-1,toe-1,toe+width,'o');
      run(part,floor-1,toe,toe+width-1,color);
      run(part,floor,toe,toe+width-1,'o');
    }
    for (const [part,pixels] of Object.entries(masks)) parts[part] = [...pixels.values()];
    const pixels = new Map();
    const layers = ['paw-right','foot-left','tail-tip','tail','body','foot-right','head','face','paw-left'];
    for (const layer of layers) {
      const marks = layer==='face' ? cat.expressionPixels('normal',pose) : parts[layer] || [];
      for (const pixel of marks) pixels.set(`${pixel.x},${pixel.y}`,pixel);
    }
    const result = { index,pose,parts,pixels:[...pixels.values()],variant:name };
    cache.set(key,result);
    return result;
  }

  const api = { duration,frames,variants,frameForVariant };
  global.CatWalkOptions = api;
  if (typeof module==='object' && module.exports) module.exports=api;
})(typeof window==='object' ? window : globalThis);
