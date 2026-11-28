(function (global) {
  'use strict';

  if (global.RoomParticles) return;
  const document = global.document;
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const motion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
  let layer = null;

  function syncVisibility() {
    layer?.classList.toggle('is-paused', document.hidden);
  }

  function pixelIcon(kind) {
    const svg = document.createElementNS(svgNamespace, 'svg');
    svg.setAttribute('viewBox', '0 0 18 18');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNamespace, 'path');
    path.setAttribute('d', kind === 'paw'
      ? 'M2 3h3v4H2zM6 1h3v4H6zM10 2h3v4h-3zM14 6h3v3h-3zM6 7h4v2h2v2h1v3h-2v1H5v-1H3v-3h1V9h2z'
      : 'M8 1h2v5h2v2h5v2h-5v2h-2v5H8v-5H6v-2H1V8h5V6h2z');
    svg.append(path);
    return svg;
  }

  function mount() {
    if (!document.body) return;
    layer = document.getElementById('roomParticles');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'roomParticles';
      layer.setAttribute('aria-hidden', 'true');
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 20; index++) {
        const kind = index % 2 === 0 ? 'paw' : index % 4 === 1 ? 'sparkle' : 'dot';
        const particle = document.createElement('span');
        particle.className = 'room-particle room-particles__item '
          + (kind === 'paw' ? 'room-particle--paw' : 'room-particle--dust')
          + (kind === 'dot' ? ' room-particles__dot' : '');
        const duration = 34 + index * 7 % 23;
        const angle = index * 11 % 49 - 24;
        const direction = index % 3 === 0 ? -1 : 1;
        const styles = {
          '--particle-x': (4 + index * 37 % 92) + '%',
          '--particle-size': (kind === 'paw' ? 13 + index * 7 % 12 : kind === 'sparkle' ? 7 + index % 5 : 3 + index % 3) + 'px',
          '--particle-duration': duration + 's',
          '--particle-delay': -(duration * ((index * .61803398875 + .18) % 1)).toFixed(2) + 's',
          '--particle-opacity': String(kind === 'paw' ? .12 + index % 4 * .025 : .13 + index % 3 * .025),
          '--particle-angle': angle + 'deg',
          '--particle-turn': (angle + direction * 9) + 'deg',
          '--particle-sway': direction * (9 + index % 5 * 4) + 'px',
          '--particle-drift': -direction * (5 + index % 4 * 3) + 'px'
        };
        Object.entries(styles).forEach(([name, value]) => particle.style.setProperty(name, value));
        if (kind !== 'dot') particle.append(pixelIcon(kind));
        fragment.append(particle);
      }
      layer.append(fragment);
      document.body.prepend(layer);
    }
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
  }

  global.RoomParticles = {
    snapshot: () => ({
      mounted: Boolean(layer?.isConnected),
      count: layer?.children.length || 0,
      paws: layer?.querySelectorAll('.room-particle--paw').length || 0,
      dust: layer?.querySelectorAll('.room-particle--dust').length || 0,
      paused: Boolean(document.hidden),
      reducedMotion: Boolean(motion?.matches)
    })
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
})(window);
