(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GLYPHS = {
    looking: [
      '..####......', '.#....#.....', '#......#....', '#......#....',
      '#......#....', '#......#....', '.#....##....', '..####.##...',
      '........##..', '.........##.', '..........##', '...........#'
    ],
    error: [
      '.####..', '##..##.', '....##.', '...##..', '..##...',
      '..##...', '.......', '..##...', '..##...', '.......'
    ],
    happy: [
      '.....######.', '.....######.', '.....##..##.', '.....##..##.',
      '.....##..##.', '.....##..##.', '.....##..##.', '...####..##.',
      '..#####.###.', '..####.####.', '.......###..', '............'
    ]
  };
  const RING_DOTS = [[4,0], [7,1], [9,4], [7,7], [4,9], [1,7], [0,4], [1,1]];

  function rectangle(document, svg, x, y, width = 1, height = 1) {
    const pixel = document.createElementNS(SVG_NS, 'rect');
    for (const [name,value] of Object.entries({ x,y,width,height })) pixel.setAttribute(name,String(value));
    svg.append(pixel);
    return pixel;
  }

  function glyph(document, state) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden','true');
    svg.setAttribute('focusable','false');
    svg.setAttribute('shape-rendering','crispEdges');
    if (state === 'thinking') {
      svg.setAttribute('viewBox','0 0 11 11');
      svg.setAttribute('width','22'); svg.setAttribute('height','22');
      RING_DOTS.forEach(([x,y],index) => {
        const pixel = rectangle(document,svg,x,y,2,2);
        pixel.style.setProperty('--dot-index',index);
      });
    } else {
      const rows = GLYPHS[state];
      svg.setAttribute('viewBox',`0 0 ${rows[0].length} ${rows.length}`);
      svg.setAttribute('width',String(rows[0].length*2));
      svg.setAttribute('height',String(rows.length*2));
      rows.forEach((row,y) => {
        for (let x = 0; x < row.length; x++) if (row[x] === '#') rectangle(document,svg,x,y);
      });
    }
    return svg;
  }

  function mount(container) {
    if (!container || container.dataset.previewStatic === 'true') return null;
    const existing = container.querySelector(':scope > .cat-state-symbols');
    if (existing) return existing;
    const document = container.ownerDocument;
    const group = document.createElement('span');
    group.className = 'cat-state-symbols';
    group.setAttribute('aria-hidden','true');
    for (const state of ['thinking','looking','error','happy']) {
      const symbol = document.createElement('span');
      symbol.className = 'cat-state-symbol cat-symbol-'+state;
      symbol.append(glyph(document,state));
      group.append(symbol);
    }
    container.append(group);
    return group;
  }

  function mountAll(root = global.document) {
    root?.querySelectorAll('.cc-container').forEach(mount);
  }

  const api = { GLYPHS,RING_DOTS,mount,mountAll };
  global.CCPixelCatSymbols = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (global.document) {
    mountAll();
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded',() => mountAll(),{ once:true });
  }
})(typeof window === 'object' ? window : globalThis);
