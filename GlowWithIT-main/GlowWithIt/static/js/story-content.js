/**
 * This class is used for storing and managing a user's answers throughout
 * the 7-step self-assessment flow. 
 * It acts as a simple data model that keeps track of selections, additional details, and
 * the current step of the assessment.
 * 
 * It has the following responsibilites:
 * 
 * 1. Hold UI components for state such as user type, schedule, and transport mode
 * 
 * 2. Provide reset functionality to clear answers
 * 
 * 3. Support both single-choice and multi-choice selections
 *  
 */
export default class StoryContent {


  currentStep;
  userType;
  workSchedule;
  transportMode;
  safetyFeatures;
  safetyLevel;
  primaryConcerns;
  emergencyContacts;
  additionalInfo;

  // initialises all fields with default values
  constructor() {

    this.currentStep = 1;
    this.userType = '';
    this.workSchedule = '';
    this.transportMode = [];
    this.safetyFeatures = [];
    this.safetyLevel = '';
    this.primaryConcerns = [];
    this.emergencyContacts = false;
    this.additionalInfo = '';
  }

  // this is to clear the pre-selected fields in the assessment back to their initial default values
  reset() {

    this.userType = '';
    this.currentStep = 1;
    this.emergencyContacts = false;
    this.workSchedule = '';
    this.transportMode = [];
    this.safetyFeatures = [];
    this.safetyLevel = '';
    this.primaryConcerns = [];
    this.additionalInfo = '';
  }

  // this is to manage the multiple select optiosn in the self-assessment form
  selectMultipleChoice(field, stepId) {

    // use a Set to store the current input that users wrote, and to avoid duplicates
    const currentInfo = new Set(this[field] || []);

    if (currentInfo.has(stepId)) {

        //if the stepId is already selected,then remove it
        currentInfo.delete(stepId);
    } else {
        
        // otherwise, add it
        currentInfo.add(stepId);
    }

    // onvert the Set back to an array
    this[field] = Array.from(currentInfo);      
  }

    toggleMulti(field, id) {
    
    this.selectMultipleChoice(field, id);
  }

  setSingle(field, id) {
    this[field] = this[field] === id ? '' : id;
  }

}
