/**
 * This class SafetyStory provides two different categorised messages: "say" and "warm" for different steps and scenarios
 * in the self-assessment form. 
 */
export default class SafetyStory {

  constructor() {

    this.data = {

      // these supportive messages are for step 1
      "step-1": {

        "walking":
        {
          say:  "Walking at night can feel a little different.",
          warm: "Let’s take the brighter streets together so it feels lighter."
        },

        "tram/train":
        {
          say:  "Platforms and tram stops can feel uneasy once it’s dark.",
          warm: "We can wait where it’s well lit and close to others."
        },

        "rideshare":
        {
          say:  "Waiting for a car on a quiet curb can feel long.",
          warm: "Let’s stand somewhere lit and share the ride details with someone you trust."
        },

        "driving":
        {
          say:  "Those last steps from the car matter too.",
          warm: "We can look for parking near good lighting so the walk back is easier."
        }
      },

      // these supportive messages are for step 2
      "step-2": {

        "before-10": {
          say:  "Early evening still feels lively.",
          warm: "Let’s keep to bright main roads and let the glow lead the way."
        },

        "10-12":
        {
          say:  "I know late evening comes with pockets of quiet.",
          warm: "Let’s link brighter stretches and keep turns simple."
        },

        "after-midnight":
        {
          say:  "After midnight the city slows down.",
          warm: "Let’s follow steady lights and keep the route straightforward."
        }
      },

      // these supportive messages are for step 3
      "step-3": {

        "harassment":
        {
          say:  "That’s heavy to bring up.",
          warm: "We can move toward people and keep support close by."
        },

        "isolation":
        {
          say:  "Empty blocks can weigh on you.",
          warm: "Let’s head toward open shopfronts and places with a bit more life."
        },

        "poor-lighting":
        {
          say:  "Dim light really changes the mood.",
          warm: "We can follow the brighter streets so everything feels clearer."
        },

        "lost":
        {
          say:  "Getting turned around happens to everyone.",
          warm: "Take a deep breath, let’s pause under a light, spot a safe venues, and reset the way."
        }
      },

      // these supportive messages are for step 4
      "step-4": {

        "busy-bright":
        {
          say:  "Busy and bright usually feels better.",
          warm: "We can go hub to hub and cross where it’s clear and marked."
        },

        "quiet-crowded":
        {
          say:  "Calm but with people nearby feels steady.",
          warm: "Let’s choose open spaces we can see into instead of tucked corners."
        }
      },

      // these supportive messages are for step 5
      "step-5": {

        "gt60": {
          say:  "Plenty of charge left, that’s good.",
          warm: "We can keep maps handy and maybe set a light check-in."
        },

        "30-60": {
          say:  "Battery looks okay for now.",
          warm: "Let’s switch on low power so it lasts the whole way."
        },

        "< 30": {
          say:  "Low battery can add some stress.",
          warm: "We can keep the route simple and share where you are with your friends while it’s still charged."
        }
      },

      // these supportive messages are for step 6
      "step-6": {

        "alone": {
          say:  "Being on your own can feel uneasy.",
          warm: "I’ll stay with you and we can let someone else know too."
        },
        "friend": {
          say:  "It’s always easier with a friend.",
          warm: "Let’s share where you’re headed so meeting up is simple."
        },

        "group": {
          say:  "The more the merrier. ",
          warm: "So let’s keep an eye on each other and stay close."
        }
      },

      // these supportive messages are for step 7 
      "step-7": {

        "sos": {
          say:  "Having help close by eases the mind.",
          warm: "Let’s keep emergency contacts just one tap away."
        },

        "location-share": {
          say:  "Being seen by someone you trust feels reassuring.",
          warm: "We can share live location with someone you can trust until you’re home safe."
        },

        "timer": {
          say:  "A quick check-in takes away the worry.",
          warm: "Let’s set a gentle timer so you get a ping when you’re home."
        },

        "venues": {
          say:  "A short pause can reset the night.",
          warm: "Let’s find a bright welcoming spot to catch your breath"
        }
      }
    };
    
    // this serves as the fallback message if none of the messages above fails to be displayed
    this.fallback = {

      say:  "I know that helps shape the journey.",
      warm: "Let’s keep it simple and kind."
    };
  }


  // retrieves a message for a specifc step and option.
  getInsightMessageByNumber(step, optionId) {

    const stepNumber= this.normaliseStepNumber(step);
    const optionNumber = String(optionId).trim();

    return this.data?.[stepNumber]?.[optionNumber] ?? this.fallback;
  }

  // normalise step number to make sure it's always in the "step-N" format
  // e.g. If input is a number (e.g., 2) → returns "step-2".
  normaliseStepNumber(step) {
    

    if (typeof step === 'number'){
      return `step-${step}`
    };

    // trim the potential trailing space
    const originalStep = String(step).trim();

    // use regex to filter
    if (/^\d+$/.test(originalStep)){
      
      return `step-${parseInt(originalStep, 10)}`;
    } 

    // return the original step number if the format is correct
    return originalStep;
  }
}
