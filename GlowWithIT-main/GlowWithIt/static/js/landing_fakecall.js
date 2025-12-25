
(() => {
  'use strict';
  const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  /* ============ 1) COUNTER ============ */
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  function startCounter(el, target = 10000, duration = 1200) {
    if (prefersReduced) { el.textContent = Number(target).toLocaleString(); return; }
    const t0 = performance.now();
    function step(now) {
      const p = Math.min(1, (now - t0) / duration);
      el.textContent = Math.floor(target * easeOutCubic(p)).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function initCounters() {
    const counters = document.querySelectorAll('.counter');
    if (!counters.length) return;
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(e => {
          if (!e.isIntersecting) return;
          io.unobserve(e.target);
          startCounter(e.target, Number(e.target.dataset.target || 10000));
        });
      }, { threshold: 0.4 });
      counters.forEach(el => io.observe(el));
    } else {
      counters.forEach(el => startCounter(el, Number(el.dataset.target || 10000)));
    }
  }

  /* ============ 2) TILT ============ */
  function initTilt() {
    if (prefersReduced) return;
    if (window.matchMedia?.('(pointer: coarse)').matches) return; // skip on touch
    const els = document.querySelectorAll('[data-tilt]');
    els.forEach(el => {
      const MAX = 10; let raf = null;
      function onMove(evt) {
        const r = el.getBoundingClientRect();
        const dx = (evt.clientX - r.left) / r.width - 0.5;
        const dy = (evt.clientY - r.top) / r.height - 0.5;
        const rx = (-dy * MAX), ry = (dx * MAX);
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => el.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`);
      }
      function reset(){ if (raf) cancelAnimationFrame(raf); el.style.transform = 'rotate(0deg)'; }
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerleave', reset);
    });
  }

  /* ============ 3) WORD FX ============ */
  const GRAD_CLASSES = ['kw-a','kw-b','kw-c','kw-d']; // colorful cycles

  // SCRAMBLE helper
  function scrambleTo(el, text, dur = 600) {
    return new Promise(resolve => {
      if (prefersReduced) { el.textContent = text; return resolve(); }
      const chars = '!<>-_\\/[]{}—=+*^?#________';
      const from = el.textContent;
      const length = Math.max(from.length, text.length);
      const queue = [];
      for (let i=0; i<length; i++){
        const fromCh = from[i] || '';
        const toCh = text[i] || '';
        const start = Math.floor(Math.random()*20);
        const end = start + Math.floor(Math.random()*20);
        queue.push({from: fromCh, to: toCh, start, end, ch: ''});
      }
      let frame = 0;
      const tick = () => {
        let out = '';
        let complete = 0;
        for (let i=0; i<queue.length; i++){
          let {from, to, start, end, ch} = queue[i];
          if (frame >= end){ complete++; out += to; }
          else if (frame >= start){
            if (!ch || Math.random() < 0.28){ ch = chars[Math.floor(Math.random()*chars.length)], queue[i].ch = ch; }
            out += ch;
          } else out += from;
        }
        el.textContent = out;
        frame++;
        if (complete === queue.length) resolve(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  function initSwap(el) {
    // words & config
    let words = [];
    try { words = JSON.parse(el.getAttribute('data-words') || '[]'); } catch {}
    if (!words.length) return;

    const hold  = Number(el.dataset.hold  || 2200);
    const speed = Number(el.dataset.speed || 700);
    const effect = (el.dataset.effect || 'flip').toLowerCase(); // default to FLIP
    let idx = 0;

    // container
    const stack = document.createElement('span');
    stack.className = 'fc-swap-stack';
    el.appendChild(stack);

    // make a word node with colorful gradient class
    function make(text, i){
      const s = document.createElement('span');
      s.className = 'fc-swap-word kw ' + GRAD_CLASSES[i % GRAD_CLASSES.length];
      s.textContent = text;
      return s;
    }

    // first word visible
    let current = make(words[0], 0);
    current.style.transform = 'translateY(0%)';
    current.style.opacity = '1';
    stack.appendChild(current);

    if (prefersReduced) return;

    // animation driver
    function cycle(){
      idx = (idx + 1) % words.length;
      const next = make(words[idx], idx);
      stack.appendChild(next);

      if (effect === 'flip'){
        current.classList.add('fc-out-flip');
        next.classList.add('fc-in-flip');
        setTimeout(() => {
          if (current.parentNode === stack) stack.removeChild(current);
          current = next; setTimeout(cycle, hold);
        }, speed);
      }
      else if (effect === 'scramble'){
        // keep the next node mounted but invisible during scramble
        next.style.opacity = '0'; next.style.transform = 'translateY(0)';
        scrambleTo(current, words[idx], Math.max(500, speed)).then(() => {
          // replace node to update gradient class cycle cleanly
          if (current.parentNode === stack) stack.replaceChild(next, current);
          next.style.opacity = '1';
          current = next; setTimeout(cycle, hold);
        });
      }
      else { // slide (default)
        current.classList.add('fc-out');
        next.classList.add('fc-in');
        setTimeout(() => {
          if (current.parentNode === stack) stack.removeChild(current);
          current = next; setTimeout(cycle, hold);
        }, speed);
      }
    }

    setTimeout(cycle, 350); // let fonts paint
  }

  function initSwaps(){
    document.querySelectorAll('.fc-swap').forEach(initSwap);
  }

  /* ============ BOOT ============ */
  const onReady = () => { initCounters(); initTilt(); initSwaps(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady, { once: true });
  } else onReady();
})();

