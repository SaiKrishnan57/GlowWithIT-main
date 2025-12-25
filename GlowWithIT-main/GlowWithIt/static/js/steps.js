/**
 * This javascript file provides helper functions and HTML templates that control how each
 * question is displayed, how answer cards are generated, and how the
 * story block is shown when the step option is selected
 *
 */


// total number of steps in the self-check flow
export const totalSteps = 7;

//this story block is for displaying the supportive texts:
export function storyBlock() {

  return `
    <div id="storyBlock" class="mt-3" hidden>
      <div class="story-line emp"></div>
      <div class="story-line aware"></div>
      <div class="story-line invite"></div>
    </div>`;
}

// this method is for displaying an answer card, which handles
// the single and multi selections and associated title, icon, group, colour and story content
export function displayAnswerCards(

  id, title, subcontent, icon, group, key, multiChoice, color = '#ff9330', storyContent
) {
  
  // this is to support current calling pattern based on  multiChoice
  let isMulti;
  if (typeof multiChoice === 'boolean') {
    isMulti = multiChoice;
  } else if (typeof key === 'boolean') {
    isMulti = key;
  } else {
    isMulti = false;
  }

  // this is to support current calling pattern based on story content
  let sc;
  if (storyContent && typeof storyContent === 'object') {
    sc = storyContent;
  } else if (typeof color === 'object') {
    sc = color;
  } else {
    sc = undefined;
  }

  // this is to support current calling pattern based on colour
  let selectedColour;

  if (typeof color === 'string') {
    selectedColour = color;
  } else if (typeof multiChoice === 'string') {
    selectedColour = multiChoice;
  } else {
    selectedColour = '#ff9330';
  }

  let isSelected = false;
  
  if (sc && Array.isArray(sc[group])){
    isSelected = sc[group].includes(id);
  }
  else if (sc && sc[group] !== undefined) {

    isSelected = sc[group] === id;
  }

  const choices = isSelected ? 'wz-tile wz-selected' : 'wz-tile';

  // renders the card
  return `
    <button type="button" class="${choices}"
      data-chip data-id="${id}" data-group="${group}"
      data-multi="${isMulti}" data-option-id="${id}">
      <span class="icon" style="color:${selectedColour}">
        <i class="bi ${icon}"></i>
      </span>
      <span>
        <div class="fw-bold">${title}</div>
        <div class="wizard-sub">${subcontent}</div>
      </span>
    </button>`;
}


// this is used as a factory method which returns an object of step with a json-like format
// and each step function returns HTML for that step
export const assessSteps = (storyContent, storyFrames = {}) => ({

  // This is for question 1 
  1()
  {
    const question1Frame= storyFrames['step-1'] || {};
    const sAnswer ='q1_mode';

    return `

      <div class="text-center mb-3">
        <h5 class="fw-bold">Your night begins! How are you getting home tonight?</h5>
      </div>
      
      <div>
        ${displayAnswerCards(
          
          'walking',
          question1Frame.walking?.title ?? 'I’ll be walking',
          question1Frame.walking?.subcontent ?? 'On foot for part or all of the trip.',
          'bi-person-walking', sAnswer, false, '#ff9330', storyContent)}

        ${displayAnswerCards(

          'tram/train',
          question1Frame['tram/train']?.title ?? 'Hopping on tram/train',
          question1Frame['tram/train']?.subcontent ?? 'Using public transport.',
          'bi-train-front', sAnswer, false, '#60a5fa', storyContent)}

        ${displayAnswerCards(
          
          'rideshare',
          question1Frame.rideshare?.title ?? 'Grabbing a taxi or rideshare',
          question1Frame.rideshare?.subcontent ?? 'A convenient option for late-night travel.',
          'bi-taxi-front', sAnswer, false, '#f59e0b', storyContent)}

        ${displayAnswerCards(
          
          'driving',
          question1Frame.driving?.title ?? 'Driving myself',
          question1Frame.driving?.subcontent ?? 'Door-to-door with a bright final approach.',
          'bi-car-front', sAnswer, false, '#34d399', storyContent)}
      </div>
      ${storyBlock()}`;
  },

  // This is for question 2
  2()
  {
    const question2Frame = storyFrames['step-2'] || {};

    const sAnswer = 'q2_time';
    return `
      <div class="text-center mb-3">
        <h5 class="fw-bold">When are you usually out and about?</h5>
      </div>
      <div>
        ${displayAnswerCards(
          
          'before-10',
          question2Frame['before-10']?.title ?? 'Before 10 PM',
          question2Frame['before-10']?.subcontent ?? 'Streets are still lively and well-lit.',
          'bi-clock', sAnswer, false, '#a78bfa', storyContent)}

        ${displayAnswerCards(
          
          '10-12',
          question2Frame['10-12']?.title ?? '10 PM – 12 AM',
          question2Frame['10-12']?.subcontent ?? 'The city’s slowing down between pockets of activity.',
          'bi-moon', sAnswer, false, '#f59e0b', storyContent)}

        ${displayAnswerCards(
          
          'after-midnight',
          question2Frame['after-midnight']?.title ?? 'After Midnight',
          question2Frame['after-midnight']?.subcontent ?? 'Quieter hours; lighting and visibility matter most.',
          'bi-moon-stars', sAnswer, false, '#22d3ee', storyContent)}
      </div>
      ${storyBlock()}`;
  },

  // This is for question 3
  3()
  {
    const question3Frame = storyFrames['step-3'] || {};
      const sAnswer = 'q3_unease';
      return `
        <div class="text-center mb-3">
          <h5 class="fw-bold">What’s the thing that makes you most uneasy at night?</h5>
        </div>
        <div>
          ${displayAnswerCards(

            'harassment',
            question3Frame.harassment?.title ?? 'Dealing with harassment or unwanted attention',
            question3Frame.harassment?.subcontent ?? 'Stares, comments, following behaviour.',
            'bi-emoji-angry', sAnswer, false, '#ef4444', storyContent)}

          ${displayAnswerCards(
            
            'isolation',
            question3Frame.isolation?.title ?? 'Being alone in empty streets',
            question3Frame.isolation?.subcontent ?? 'Few people around;',
            'bi-emoji-neutral', sAnswer, false, '#f59e0b', storyContent)}

          ${displayAnswerCards(
            
            'poor-lighting',
            question3Frame['poor-lighting']?.title ?? 'Streets that aren’t well-lit',
            question3Frame['poor-lighting']?.subcontent ?? 'Dim light, shadows and blind corners.',
            'bi-lightbulb-off', sAnswer, false, 'var(--icon-poor-lighting)', storyContent)}

          ${displayAnswerCards(
            
            'lost',
            question3Frame.lost?.title ?? 'Losing my way',
            question3Frame.lost?.subcontent ?? 'Unfamiliar turns, detours or confusing layouts.',
            'bi-compass', sAnswer, false, '#60a5fa', storyContent)}
        </div>
        ${storyBlock()}`;
    },

  // This is for question 4
  4() 
  {

    const question4Frame = storyFrames['step-4'] || {};
    const sAnswer = 'q4_stop';
    return `
      <div class="text-center mb-3">
        <h5 class="fw-bold">If you had to stop for a while, what would feel safest?</h5>
      </div>
      <div>
        ${displayAnswerCards(
          
          'busy-bright',
          question4Frame['busy-bright']?.title ?? 'Somewhere busy & bright',
          question4Frame['busy-bright']?.subcontent ?? 'Shops, transport hubs, places with people around.',
          'bi-brightness-high', sAnswer, false, '#f59e0b', storyContent)}

        ${displayAnswerCards(

          'quiet-crowded',
          question4Frame['quiet-crowded']?.title ?? 'Somewhere quiet but crowded',
          question4Frame['quiet-crowded']?.subcontent ?? 'Places like Cafés, libraries.',
          'bi-person-badge', sAnswer, false, '#22d3ee', storyContent)}
      </div>
      ${storyBlock()}`;
  },

  // This is for question 5
  5()
  {
    const question5Frame = storyFrames['step-5'] || {};
    const sAnswer = 'q5_battery';
    return `

      <div class="text-center mb-3">
        <h5 class="fw-bold">How’s your phone battery holding up?</h5>
      </div>

      <div>
        ${displayAnswerCards(
          
          'gt60',
          question5Frame.gt60?.title ?? 'Strong & steady (>60%)',
          question5Frame.gt60?.subcontent ?? 'Good for maps and calls.',
          'bi-battery-full', sAnswer, false, '#22c55e', storyContent)}

        ${displayAnswerCards(
          
          '30-60',
          question5Frame['30-60']?.title ?? 'Half tank (30–60%)',
          question5Frame['30-60']?.subcontent ?? 'Enough with a little care.',
          'bi-battery-half', sAnswer, false, '#eab308', storyContent)}

        ${displayAnswerCards(
          
          '<30',
          question5Frame['<30']?.title ?? 'Running low (<30%)',
          question5Frame['<30']?.subcontent ?? 'Save power for what matters.',
          'bi-battery', sAnswer, false, '#ef4444', storyContent)}
      </div>
      ${storyBlock()}`;
  },

  // This is for question 6
  6()
  {
    const question6Frame = storyFrames['step-6'] || {};
    const sAnswer = 'q6_company';

    return `
      <div class="text-center mb-3">
        <h5 class="fw-bold">Who’s with you tonight?</h5>
      </div>
      <div>

        ${displayAnswerCards(
          
          'alone',
          question6Frame.alone?.title ?? 'Alone',
          question6Frame.alone?.subcontent ?? 'Travelling solo most or all of the way.',
          'bi-person', sAnswer, false, '#f97316', storyContent)}

        ${displayAnswerCards(
          
          'friend',
          question6Frame.friend?.title ?? 'With a friend',
          question6Frame.friend?.subcontent ?? 'Travelling or checking in together.',
          'bi-people', sAnswer, false, '#8b5cf6', storyContent)}

        ${displayAnswerCards(
          
          'group',
          question6Frame.group?.title ?? 'In a group',
          question6Frame.group?.subcontent ?? 'Moving together with others.',
          'bi-people-fill', sAnswer, false, '#14b8a6', storyContent)}
      </div>
      ${storyBlock()}`;
  },

  // This is for question 7
  7()
  {
    const question7Frame = storyFrames['step-7'] || {};
    const multiQ = 'q7_powers'; 
    return `
      <div class="text-center mb-3">
        <h5 class="fw-bold">What safety powers would you like tonight?</h5>
        <div class="wizard-sub">Choose any that help</div>
      </div>
      <div>
        ${displayAnswerCards(
          
          'sos',
          question7Frame.sos?.title ?? 'Instant access to emergency numbers',
          question7Frame.sos?.subcontent ?? 'Quick-dial 000 / 106 / 112 and helplines.',
          'bi-telephone-forward', multiQ, true, '#3b82f6', storyContent)}

        ${displayAnswerCards(
          
          'location-share',
          question7Frame.share?.title ?? 'Share my live location with a buddy',
          question7Frame.share?.subcontent ?? 'Send a link so someone can keep an eye.',
          'bi-share', multiQ, true, '#10b981', storyContent)}

        ${displayAnswerCards(
          
          'timer',
          question7Frame.timer?.title ?? 'A reminder to check-in after 5 minutes',
          question7Frame.timer?.subcontent ?? 'A nudge so someone knows you’re home.',
          'bi-alarm', multiQ, true, '#f59e0b', storyContent)
        }

        ${displayAnswerCards(
          
          'venues',
          question7Frame.venues?.title ?? 'Show me safer places around',
          question7Frame.venues?.subcontent ?? 'Brighter, staffed or watched spaces nearby.',
          'bi-shop', multiQ, true, '#e11d48', storyContent)}
      </div>
      ${storyBlock()}`;
  }
});
