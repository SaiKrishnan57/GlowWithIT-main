import { assessSteps, totalSteps } from './steps.js';
import SafetyStory from './safety-stories.js';
import { planToActions } from './plan-to-map.js';

/**
 * This class SelfCheckCard is to provide logics for 7-step self-check experience
 * Responsibilities:
 * 1. Render each step’s UI components
 * 2. Manage navigation (Next/Previous, progress bar, dots)
 * 3. Show step options + illustrations
 * 4. Animate transitions + micro interactions
 */
export default class SelfCheckCard {

  constructor(storyContent, safetyStory, storyFrames = {}) {

    this.storyContent = storyContent;
    this.storyFrames  = storyFrames;

    // Grab DOM first
    this.stepContainer = document.getElementById('stepContainer');
    this.progressBar   = document.getElementById('progressBar');
    this.stepNow       = document.getElementById('stepNow');
    this.totalStepsEl  = document.getElementById('stepTotal');
    this.prevButton    = document.getElementById('prevBtn');
    this.nextButton    = document.getElementById('nextBtn');
    this.progressDots  = document.getElementById('dots');
    this.insightArea   = document.getElementById('insightArea');

    // Use the container that wraps both step & insight (prevents twitch)
    this.cardShell = (this.stepContainer && this.stepContainer.parentElement)
                    || document.getElementById('safetyCard')
                    || this.stepContainer || document.body;

    // SafetyStory instance: prefer provided, else make one
    const looksLikeSafetyStory =
      safetyStory && (typeof safetyStory.getInsightMessageByNumber === 'function' ||
                      typeof safetyStory.getInsightMessageByKey === 'function');
    this.sq = looksLikeSafetyStory ? safetyStory : new SafetyStory();
    this.safetyStory = this.sq;
    this._insightTl = null;
    this._minHeightResetTimer = null;
    this._transitioning = false;
    this.eventControl = null;

    this.insightIllustrations = {
      'step-1': {
        walking: '/static/images/walking.webp',
        'tram/train': '/static/images/tram.webp',
        rideshare: '/static/images/rideshare.webp',
        driving: '/static/images/driving.webp',
      },
      'step-2': {
        'before-10': '/static/images/before10pm.webp',
        '10-12': '/static/images/12am.webp',
        'after-midnight': '/static/images/after12.webp',
      },
      'step-3': {
        harassment: '/static/images/harassment.jpg',
        isolation: '/static/images/lonely.jpg',
        'poor-lighting': '/static/images/poorly-lit.jpg',
        lost: '/static/images/lost.webp',
      },
      'step-4': {
        'busy-bright': '/static/images/crowd.webp',
        'quiet-crowded': '/static/images/quiet.webp',
      },
      'step-5': {
        gt60: '/static/images/full-battery.jpeg',
        '30-60': '/static/images/half-battery.jpeg',
        '<30': '/static/images/low-battery.jpeg',
      },
      'step-6': {
        alone: '/static/images/walking-alone.jpg',
        friend: '/static/images/friend.webp',
        group: '/static/images/group-friend.jpg',
      },
      'step-7': {
        sos: '/static/images/sos.webp',
        'location-share': '/static/images/location-sharing.webp',
        timer: '/static/images/5min-alert.jpg',
        venues: '/static/images/safe-venues.webp',
      },
    };

    if (this.totalStepsEl){
      this.totalStepsEl.textContent = String(totalSteps);
    }

    this.setUpListener(); // set once per instance
    this.reset();         // initial fresh state
  }

    _lockHeight(el, fn) {

    const target = el || this.cardShell;
    if (!target) { fn?.(); return; }
    const h = Math.round(target.getBoundingClientRect().height || 0);
    if (h > 0) target.style.minHeight = h + 'px';
    fn?.();
    requestAnimationFrame(() => {
      clearTimeout(this._minHeightResetTimer);
      this._minHeightResetTimer = setTimeout(() => {
        target.style.minHeight = '';
      }, 160);
    });
  }

  setUpListener() {

    this.eventControl?.abort();
    this.eventControl = new AbortController();
    const { signal } = this.eventControl;

    this.prevButton?.addEventListener('click', () => {
      if (this._transitioning) return;
      if (this.storyContent.currentStep > 1) {
        this.clearInsight(); 
        if (window.gsap) {
          const warn = document.getElementById('stepWarning');
          if (warn) gsap.killTweensOf(warn);
          if (this.nextButton) {
            gsap.killTweensOf(this.nextButton);
            gsap.set(this.nextButton, { clearProps: 'transform' });
          }
        }
        this._transitioning = true;
        this.animateOut(() => {
          this.moveToTargetedStep(this.storyContent.currentStep - 1);
          this._transitioning = false;
        });
      }
    }, { signal });

    this.nextButton?.addEventListener('click', () => {
      if (this._transitioning) return;

      if (this.storyContent.currentStep < totalSteps) {
        if (!this.validateCurrentStep?.()) return;
        this.clearInsight(); // <-- important

        if (window.gsap) {
          const warn = document.getElementById('stepWarning');
          if (warn) gsap.killTweensOf(warn);
          if (this.nextButton) {
            gsap.killTweensOf(this.nextButton);
            gsap.set(this.nextButton, { clearProps: 'transform' });
          }
        }
        this._transitioning = true;
        this.animateOut(() => {
          this.moveToTargetedStep(this.storyContent.currentStep + 1);
          this._transitioning = false;
        });

      } else {
        this.applyPlanToMapBridgeSafely();
        document.getElementById('safetyCard')?.classList.add('d-none');
        document.getElementById('resultsCard')?.classList.remove('d-none');
        queueMicrotask(() => this.displayResults?.());
      }
    }, { signal });
  }


  reset() {
    if (typeof this.storyContent.reset === 'function') this.storyContent.reset();
    this.storyContent.currentStep = 1;

    this.clearWarning();
    this.clearHighlights();
    this.clearInsight();

    this.moveToTargetedStep(1);
  }

  destroy() {
    this.eventControl?.abort();
    this.eventControl = null;
    this.clearWarning();
    this.clearHighlights();
    this.clearInsight();
  }

  moveToTargetedStep(step) {
    this.storyContent.currentStep = step;
    if (this.stepNow) this.stepNow.textContent = String(step);

    const pct = Math.round((step / totalSteps) * 100);
    this.moveProgressBar(pct);

    this.clearWarning();
    this.clearHighlights();
    this.clearInsight();

    if (this.prevButton) this.prevButton.disabled = (step === 1);

    if (this.nextButton) {
      this.nextButton.innerHTML =
        (step === totalSteps)
          ? 'Finish <i class="bi bi-chevron-right ms-2"></i>'
          : 'Next <i class="bi bi-chevron-right ms-2"></i>';
    }

    this.displayProgressDots();
    this.displayStep();
  }

  displayProgressDots() {
    const dots = this.progressDots;
    if (!dots) return;
    dots.innerHTML = '';

    for (let i = 1; i <= totalSteps; i++) {
      const dot = document.createElement('div');
      dot.style.cssText = 'width:10px;height:10px;border-radius:999px;';
      dot.style.background =
        (i <= this.storyContent.currentStep)
          ? 'linear-gradient(90deg, #ff9330, #ec4899)'
          : 'rgba(255,255,255,.25)';
      dots.appendChild(dot);
    }
  }

  displayStep() {

    if (!this.stepContainer) return;

    this._lockHeight(this.cardShell, () => {
      const view = assessSteps(this.storyContent, this.storyFrames)[this.storyContent.currentStep]();
      this.stepContainer.innerHTML = view;

      this.clearWarning();
      this.clearHighlights();

      // chip click handlers
      this.stepContainer.querySelectorAll('[data-chip]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const { optionId, id, group, multi } = btn.dataset;
          const chosen = optionId ?? id;
          const before = this.getSelectedChoiceForGroup(group);

          if (multi === 'true') {
            this.storyContent.toggleMulti(group, chosen);
          } else {
            if (before === chosen) this.storyContent.unsetSingle?.(group);
            else this.storyContent.setSingle(group, chosen);
          }

          this.clearWarning();
          this.palse(btn);
          this.updateChipVisuals(group);

          const after = this.getSelectedChoiceForGroup(group);
          const empty = (after == null) ||
                        (Array.isArray(after) ? after.length === 0
                                              : (typeof after === 'string' ? after.trim() === '' : false));

          if (empty) {
            this.clearInsight();
            this.clearHighlights();
          } else {
            this.clearHighlightsForGroup(group);
            this.showInsight(this.storyContent.currentStep, chosen); // pass NUMBER
          }

          this.displayStory(); // no full step rebuild
        });
      });

      // emergency contacts toggle
      const emergencyContacts = document.getElementById('emContacts');
      if (emergencyContacts) {
        emergencyContacts.addEventListener('change', (e) => {
          this.storyContent.emergencyContacts = e.target.checked;
          this.displayStory();
        });
      }

      // additional info
      const additionalText = document.getElementById('additionalInfo');
      if (additionalText) {
        additionalText.addEventListener('input', (e) => {
          this.storyContent.additionalInfo = e.target.value;
        });
      }

      this.paintAllSelections();
      this.animateIn();
    });
  }



  displayStory() {
    const block = document.getElementById('storyBlock');
    if (!block) return;

    const { emp, aware, invite } =
      this.safetyStory.getInsightMessageByNumber(this.storyContent.currentStep, this.storyContent);

    block.querySelector('.emp').textContent    = emp || '';
    block.querySelector('.aware').textContent  = aware || '';
    block.querySelector('.invite').textContent = invite || '';
    block.hidden = false;

    if (window.gsap) {
      gsap.killTweensOf('#storyBlock .story-line');
      gsap.fromTo('#storyBlock .story-line',
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.28, stagger: 0.07, overwrite: 'auto' }
      );
    }
  }

  showInsight(stepNumber, optionId) {
    
    if (!this.insightArea) return;

    const stepKey = (typeof stepNumber === 'number') ? `step-${stepNumber}` : String(stepNumber);
    const img = this.insightIllustrations[stepKey]?.[optionId];

    let say = '', warm = '';
    if (typeof stepNumber === 'number' && typeof this.sq.getInsightMessageByNumber === 'function') {
      const res = this.sq.getInsightMessageByNumber(stepNumber, optionId, this.storyContent);
      if (res) ({ say, warm } = res);
    } else if (typeof this.sq.getInsightMessageByKey === 'function') {
      const res = this.sq.getInsightMessageByKey(stepKey, optionId, this.storyContent);
      if (res) ({ say, warm } = res);
    } else {
      console.warn('No Safety story API available.');
      return;
    }

    const html = `
      <div class="insight-say">${this.checkIfTextIsString(say)}</div>
      <div class="insight-invite">${this.checkIfTextIsString(warm)}</div>
      &nbsp;
      <img class="insight-illust" src="${img}"
          loading="lazy" decoding="async" width="320" height="210"
          style="display:block;width:100%;max-width:320px;height:210px;object-fit:cover;object-position:center 30%;">
    `;

    if (!window.gsap) {
      this._lockHeight(this.cardShell, () => {
        this.insightArea.innerHTML = html;
        this.insightArea.classList.remove('d-none');
      });
      return;
    }

    try { gsap.killTweensOf(this.insightArea.children); } catch {}
    const firstTime = this.insightArea.classList.contains('d-none');

    this._lockHeight(this.cardShell, () => {
      const tl = gsap.timeline({ defaults: { duration: 0.22, ease: 'power2.out', overwrite: 'auto' } });
      if (firstTime) {
        this.insightArea.innerHTML = html;
        this.insightArea.classList.remove('d-none');
        tl.from(this.insightArea.children, { opacity: 0, y: 8, stagger: 0.06 });
      } else {
        tl.to(this.insightArea.children, { opacity: 0, y: 6, stagger: 0.04 })
          .call(() => { this.insightArea.innerHTML = html; })
          .from(this.insightArea.children, { opacity: 0, y: 8, stagger: 0.06 }, '+=0.02');
      }
    });
  }

  clearInsight() {
    if (!this.insightArea) return;

    if (!window.gsap) {
      this._lockHeight(this.cardShell, () => {
        this.insightArea.innerHTML = '';
        this.insightArea.classList.add('d-none');
      });
      return;
    }

    this._insightTl?.kill();
    this._insightTl = gsap.timeline({
      defaults: { overwrite: 'auto' },
      onComplete: () => { this._insightTl = null; }
    });

    this._lockHeight(this.cardShell, () => {
      this._insightTl.to(this.insightArea, {
        opacity: 0, y: 4, duration: 0.15,
        onComplete: () => {
          this.insightArea.innerHTML = '';
          this.insightArea.classList.add('d-none');
          gsap.set(this.insightArea, { clearProps: 'opacity,transform' });
        }
      });
    });
  }


  // GSAP animation when options appear
  animateIn() {
    if (!window.gsap) {
      if (this.stepContainer) this.stepContainer.style.minHeight = '';
      return;
    }

    gsap.killTweensOf('.wz-tile');
    gsap.from('.wz-tile', {
      opacity: 0,
      y: 16,
      duration: 0.35,
      stagger: 0.05,
      onComplete: () =>  {
        gsap.set('.wz-tile', { clearProps: 'opacity,transform' });
        if (this.stepContainer) this.stepContainer.style.minHeight = '';
      }
    });
  }

  // Animation when step fades out — MUST always call next()
  animateOut(next) {

    if (!window.gsap) {

      next();
      return;
    }

    const tiles = gsap.utils.toArray('.wz-tile');
    const lines = gsap.utils.toArray('#storyBlock .story-line');
    const ikids = this.insightArea ? Array.from(this.insightArea.children) : [];
    const any = tiles.length || lines.length || ikids.length;

    gsap.killTweensOf([...tiles, ...lines, ...(ikids || [])]);

    const warn = document.getElementById('stepWarning');

    if (warn) gsap.killTweensOf(warn);

    if (this.nextButton) {

      gsap.killTweensOf(this.nextButton);
      gsap.set(this.nextButton, { clearProps: 'transform' });
    }

    if (!any) { next(); return; }

    this._lockHeight(this.cardShell, () => {

      const tl = gsap.timeline({
        defaults: { duration: 0.2, ease: 'power2.out' },
        onComplete: () => {
          // clear insight after fade so layout doesn’t jump pre-transition
          if (this.insightArea) {
            this.insightArea.innerHTML = '';
            this.insightArea.classList.add('d-none');
            gsap.set(this.insightArea, { clearProps: 'opacity,transform' });
          }
          next();
        }
      });

      if (tiles.length) tl.to(tiles, { opacity: 0, y: -10, stagger: 0.04 }, 0);
      if (lines.length) tl.to(lines, { opacity: 0, x: 8,  stagger: 0.05 }, 0);
      if (ikids.length) tl.to(ikids, { opacity: 0, y: 6,  stagger: 0.04 }, 0);
    });
  }


  palse(element) {
    if (!window.gsap || !element) return;
    gsap.killTweensOf(element);
    gsap.to(element, {
      scale: 1.03,
      duration: 0.12,
      yoyo: true,
      repeat: 1,
      overwrite: 'auto',
      force3D: false,
      onComplete: () => gsap.set(element, { clearProps: 'transform' })
    });
  }

  moveProgressBar(percent) {
    const bar = this.progressBar;
    if (!bar) return;
    if (window.gsap) gsap.to(bar, { width: percent + '%', duration: 0.3 });
    else bar.style.width = percent + '%';
  }

  checkIfTextIsString(s) {
    return String(s || '').replace(/[&<>"]/g, ch => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
    ));
  }

  validateCurrentStep() {
    if (!this.stepContainer) return true;

    const groups = this.getStepGroups();
    if (groups.length === 0) return true;

    for (const group of groups) {
      const selected = this.getSelectedChoiceForGroup(group);

      let noneSelected;
      if (selected == null) {
        noneSelected = true;
      } else if (Array.isArray(selected)) {
        noneSelected = selected.length === 0;
      } else if (typeof selected === 'string') {
        noneSelected = selected.trim() === '';
      } else {
        noneSelected = false;
      }

      if (noneSelected) {
        this.warningMessage('Please choose an option to continue the self-check.');
        this.highlightGroup(group);
        return false;
      }
    }

    this.clearWarning();
    return true;
  }

  getStepGroups() {
    const chips = this.stepContainer?.querySelectorAll('[data-chip]') ?? [];
    const set = new Set();
    chips.forEach(btn => { if (btn.dataset.group) set.add(btn.dataset.group); });
    return [...set];
  }

  getSelectedChoiceForGroup(group) {
    const sc = this.storyContent || {};
    let base;
    if (sc.selections && typeof sc.selections === 'object') base = sc.selections;
    else base = sc;
    return base[group];
  }

  warningMessage(message) {
    let warnPop = document.getElementById('stepWarning');
    if (!warnPop) {
      warnPop = document.createElement('div');
      warnPop.id = 'stepWarning';
      warnPop.className = 'step-warning';
      this.stepContainer?.parentElement?.insertBefore(warnPop, this.stepContainer);
    }

    warnPop.textContent = message;
    warnPop.hidden = false;

    if (window.gsap) {
      gsap.fromTo(warnPop, { y: -4, opacity: 0 }, { y: 0, opacity: 1, duration: 0.18 });
      gsap.fromTo(this.nextButton,
        { x: 0 },
        { x: 6, yoyo: true, repeat: 2, duration: 0.07,
          onComplete: () => { if (this.nextButton) gsap.set(this.nextButton, { clearProps: 'transform' }); }
        });
    }
  }

  clearWarning() {
    const warnElement = document.getElementById('stepWarning');
    if (warnElement) {
      if (window.gsap) {
        gsap.killTweensOf(warnElement);
        if (this.nextButton) {
          gsap.killTweensOf(this.nextButton);
          gsap.set(this.nextButton, { clearProps: 'transform' });
        }
      }
      warnElement.remove();
    }
  }

  highlightGroup(group) {
    if (!this.stepContainer) return;
    this.clearHighlights();
    this.stepContainer
      .querySelectorAll(`[data-chip][data-group="${group}"]`)
      .forEach(btn => btn.classList.add('is-required'));
  }

  clearHighlights() {
    if (!this.stepContainer) return;
    this.stepContainer
      .querySelectorAll('.is-required')
      .forEach(btn => btn.classList.remove('is-required'));
  }

  clearHighlightsForGroup(group) {
    if (!this.stepContainer) return;
    this.stepContainer
      .querySelectorAll(`[data-chip][data-group="${group}"].is-required`)
      .forEach(btn => btn.classList.remove('is-required'));
  }

  updateChipVisuals(group) {
    if (!this.stepContainer) return;
    const current = this.getSelectedChoiceForGroup(group);
    const isArray = Array.isArray(current);

    this.stepContainer
      .querySelectorAll(`[data-chip][data-group="${group}"]`)
      .forEach(btn => {
        const { optionId, id } = btn.dataset;
        const key = optionId ?? id;
        const on = (isArray ? current?.includes?.(key) : current === key);
        btn.classList.toggle('wz-selected', !!on);
      });
  }

  paintAllSelections() {
    this.getStepGroups().forEach(g => this.updateChipVisuals(g));
  }

  applyPlanToMapBridgeSafely() {
    try {
      const q7 = this.getSelectedChoiceForGroup?.('q7_powers');
      const pickedPowers = Array.isArray(q7) ? q7 : [];

      let topCategories = Array.isArray(this.storyContent?.topCategories)
        ? this.storyContent.topCategories
        : null;

      if (!topCategories || topCategories.length === 0) {
        const stateForScoring = this.storyContent?.selections || this.storyContent || {};

        if (typeof window.calculateScoreForAssessmentForm === 'function' &&
            typeof window.top3Categories === 'function') {
          const scores = window.calculateScoreForAssessmentForm(stateForScoring);
          topCategories = window.top3Categories(scores, 3);
        } else if (typeof this.calculateScoreForAssessmentForm === 'function' &&
                   typeof this.top3Categories === 'function') {
          const scores = this.calculateScoreForAssessmentForm(stateForScoring);
          topCategories = this.top3Categories(scores, 3);
        }
      }

      if (!Array.isArray(topCategories)) topCategories = [];

      const actions = planToActions(topCategories, pickedPowers);

      if (typeof window.applySafetyActions === 'function') {
        window.applySafetyActions(actions);
      } else {
        window.__pendingSafetyActions = actions;
      }

      document.dispatchEvent(new CustomEvent('gw:planReady', {
        detail: { actions, topCategories, pickedPowers }
      }));
    }
    catch (err) {
      console.error('SelfCheckCard Failed to call plan which redircets to the map', err);
    }
  }

  displayResults() {
    const resultsEl = document.getElementById('personalizationResults');
    if (!resultsEl) return;

    const model = this.storyContent?.selections || this.storyContent || {};

    const calc   = window.calculateScoreForAssessmentForm;
    const pick   = window.top3Categories;
    const plan3  = window.buildPersonalisedSafetyPlan;
    const tips   = window.scoringTips || {};

    if (typeof calc !== 'function' || typeof pick !== 'function' || typeof plan3 !== 'function') {
      console.warn('[displayResults] scoring helpers not found on window.*');
      resultsEl.innerHTML = `
        <div class="col-12"><div class="alert alert-warning">
          Results could not be computed. Missing scoring helpers.
        </div></div>`;
      return;
    }

    const scores = calc(model);
    const top    = pick(scores, 3);
       const steps  = plan3(top);

    const q7 = this.getSelectedChoiceForGroup?.('q7_powers');
    const pickedPowers = Array.isArray(q7) ? q7 : [];
    const actions = (typeof window.planToActions === 'function'
                      ? window.planToActions(top, pickedPowers)
                      : planToActions(top, pickedPowers));

    window.__lastActions = actions;

    const route = actions.find(a => a.type === 'route')?.payload || {};
    const layer = actions.find(a => a.type === 'layer')?.payload || {};
    const util  = actions.find(a => a.type === 'utility')?.payload || {};

    const chips = [
      route.preferLit ? 'Prefer lit streets' : null,
      route.avoidAlleys ? 'Avoid alleys/parks' : null,
      layer.visible ? 'Safe venues ON' : 'Safe venues OFF',
      util.sos ? 'SOS ready' : null,
      util.timer ? 'Check-in timer' : null,
      util.share ? 'Location share' : null,
    ].filter(Boolean).map(s => `<span class="svm-chip">${s}</span>`).join(' ');

    resultsEl.innerHTML = `
      <div class="col-12">
        <div class="card-glass p-3 rounded-3 mb-2">
          <div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
            <h5 class="mb-2">Tonight’s plan:</h5>
            <div class="small" style="opacity:.9">${chips}</div>
          </div>
          <ol class="mb-0">
            ${steps.map(li => `<li>${li}</li>`).join('')}
          </ol>
          <div class="mt-3">
            <button id="btn-focus-map" class="btn btn-amber">Show on map</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btn-focus-map')?.addEventListener('click', () => {
      document.getElementById('safety-map-block')?.scrollIntoView({ behavior: 'smooth' });
      if (typeof window.applySafetyActions === 'function') {
        window.applySafetyActions(window.__lastActions);
      } else {
        window.__pendingSafetyActions = window.__lastActions;
      }
      document.dispatchEvent(new CustomEvent('gw:focusMapFromResults', {
        detail: { actions: window.__lastActions }
      }));
    });

    document.getElementById('retakeBtn')?.addEventListener('click', () => {
      document.getElementById('resultsCard')?.classList.add('d-none');
      document.getElementById('safetyCard')?.classList.remove('d-none');
      this.reset();
    });
  }
}