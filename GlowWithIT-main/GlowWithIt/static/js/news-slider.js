/**
 * This news-slider.js is used for the homepage “News Slider” component.
 * It has the following responsibilities:
 * 
 * 1. Builds a horizontally scrolling carousel of news report with clickable urls
 * 
 * 2. Autoplays on a timer on the loop
 * 
 * 3. Users can use buttons and drag or swipe on desktop and mobile screens.
 * 
 * 4. Clones a few news cards to the end so the slider can loop seamlessly.
 *
*/

(function () {

  'use strict';

  // this flag is used for tracking the state of news slider, if this is missing, then return immediately
  var track = document.getElementById('newsTrack');
  
  if (!track) return;

  var previousButton = document.getElementById('newsPrev');
  var nextButton = document.getElementById('newsNext');

 // the current index of the card
  var index = 0;         
  var cardWidth = 0;         
  var visibility = 0;      
  var isDown = false;
  // start point of the drag behaviour
  var startX = 0;         
  var scrollStart = 0;  


  // this is to measure  sizes and recalculate the visibility of the cards
  // and rebuild cloned cards and add them to the back of the sliders to the current index
  function measure() {

    var card = track.querySelector('.news-card');
    if (!card) return;

    var gapStr = window.getComputedStyle(track).gap || '0';
    var gap = parseFloat(gapStr) || 0;

    //width of the card and the gap between each card
    cardWidth = card.getBoundingClientRect().width + gap;

    // this is to define how many cards can we see in the viewpot
    var viewport = track.parentElement;
    var viewportWidth = viewport ? viewport.getBoundingClientRect().width : 0;
    // the visibility is calculated by the formula
    visibility = Math.max(1, Math.floor(viewportWidth / cardWidth));

    rebuildClones();
    goTo(index, /*snap*/ true);
  }

  /**
   * Rebuild “loop” clones at the end of the track.
   * We remove old clones (marked with .is-clone) and append fresh ones.
   */
  function rebuildClones() {
    // Remove any previous clones
    var oldClones = track.querySelectorAll('.is-clone');
    for (var i = 0; i < oldClones.length; i++) oldClones[i].remove();

    // Work only with original cards
    var originals = [];
    var kids = track.children;
    for (var j = 0; j < kids.length; j++) {
      if (!kids[j].classList.contains('is-clone')) originals.push(kids[j]);
    }
    if (originals.length === 0) return;

    // this is to calculate the total numbers of the cloned cards that we need for the slider
    var needed = Math.min(visibility + 2, originals.length);

    for (var k = 0; k < needed; k++) {
      var clone = originals[k].cloneNode(true);
      clone.classList.add('is-clone');
      track.appendChild(clone);
    }
  }

  /**
   * Move to a given card index. If `snap` is true, jump without animation.
   * Otherwise animate. When we slide onto a clone, reset to the start after.
   */
  function goTo(i, snap) {
    track.style.transition = snap ? 'none' : 'transform .55s cubic-bezier(.22,.61,.36,1)';
    track.style.transform = 'translateX(' + (-i * cardWidth) + 'px)';
    index = i;

    // Count originals (not clones). If we scrolled beyond them, we’re on a clone.
    var originalsCount = track.querySelectorAll('.news-card:not(.is-clone)').length;
    if (index >= originalsCount) {

      // After the animation finishes, jump back to the real first card without any sensible flicks.
      setTimeout(function () {
        track.style.transition = 'none';
        index = 0;
        track.style.transform = 'translateX(0px)';

        // Force reflow so the browser accepts the no-transition transform…
        track.getBoundingClientRect();
        
        track.style.transition = 'transform .55s cubic-bezier(.22,.61,.36,1)';
      }, 560);
    }
  }

  /** Convenience: move forward/backward by d cards (usually +1 or -1). */
  function step(d) {
    goTo(index + d, /*snap*/ false);
  }

  //automatically play the slider every 5 minutes and then jump back to the very beginning
  var auto = setInterval(function () { step(1); }, 5000);

  function resetAuto() {
    clearInterval(auto);
    auto = setInterval(function () { step(1); }, 5000);
  }

  //Next Card Button
  if (nextButton) {
    
    nextButton.addEventListener('click', function () {
      step(1);
      resetAuto();
    });
  }

   //Previous Card Button
  if (previousButton) {

    previousButton.addEventListener('click', function () {
    
      if (index === 0){
         index = 1;
      }
      step(-1);
      resetAuto();
    });
  }

  // this method is to handle the drag motion 
  function onDown(clientX) {

    isDown = true;
    startX = clientX;
    scrollStart = index * cardWidth;
    track.style.cursor = 'grabbing';
    track.style.transition = 'none'; // free move while dragging
  }

  // this method is to handle the move motion with the finger or a mouse 
  function onMove(clientX) {

    if (!isDown) return;
    var distanceXAxis = clientX - startX;
    track.style.transform = 'translateX(' + -(scrollStart - distanceXAxis) + 'px)';
  }

  function onUp(clientX) {
    if (!isDown) return;
    isDown = false;
    track.style.cursor = 'grab';

    // calculate the distance 
    var distanceXAxis = clientX - startX;

    var threshold = cardWidth * 0.25; // this is a threshold value for defining how far the user can drag the cards

    if (distanceXAxis < -threshold) {
      // go to the next card if the current card is dragged to the left
      step(1);
    } 
    else if (distanceXAxis > threshold) {
      // go to the previous card if the current card is dragged to the right
      if (index === 0) index = 1; 
      step(-1);
    } else {
      
      // go back to the current state if the card is not dragged far enough to be identified
      goTo(index,false);
    }
    resetAuto();
  }

  // These are used for defining mouse events
  track.addEventListener('mousedown', 
    function (event) {
      onDown(event.clientX);

    });

  window.addEventListener('mousemove', 
    function (event) {
      onMove(event.clientX);
    });

  window.addEventListener('mouseup',

    function (event) {
      onUp(event.clientX);
    });

  track.addEventListener('mouseleave', 
    
    function () {

    // If the pointer leaves while dragging, treat it as releas the mouse.
    if (isDown){
       onUp(startX);
    }
  });

  // Touch events 
  track.addEventListener('touchstart', function (e) {
    if (!e.touches || !e.touches[0]) return;
    onDown(e.touches[0].clientX);
  }, { passive: true });

  track.addEventListener('touchmove', function (e) {
    if (!e.touches || !e.touches[0]) return;
    onMove(e.touches[0].clientX);
  }, { passive: true });

  track.addEventListener('touchend', function (e) {
    var t = (e.changedTouches && e.changedTouches[0]) || null;
    onUp(t ? t.clientX : startX);
  });

  // Recalculate on resize so the slider still lines up with CSS sizes.
  window.addEventListener('resize', measure);

  // Initial setup
  measure();
})();
