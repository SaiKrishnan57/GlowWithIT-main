

(function(){

  const STORAGE_KEY = 'gw-theme'; 
  const root = document.documentElement;
  const brightSwitch = document.getElementById('gwSwitch');
  const label = document.getElementById('gwToggleLabel');

  function switchMode(theme){

    // bright mode
    const isBright = theme === 'bright';
    root.classList.toggle('gw-bright', isBright);

    if (brightSwitch) brightSwitch.checked = isBright;
    
    if (label){
      
      label.textContent = isBright ? 'Bright Mode' : 'Night Mode';
    }
  }

  function read(){

    const currnetMode = localStorage.getItem(STORAGE_KEY);

    if (currnetMode === 'bright' || currnetMode === 'night') return currnetMode;

    //default theme is light mode
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'bright' : 'night';
  }

  // read the storage key retriving from the localStorage
  const initial = read();

  // turn on/off the swtich
  switchMode(initial);

  if (brightSwitch) {

    brightSwitch.addEventListener('change', (event) => {

      const theme = event.target.checked ? 'bright' : 'night';

      // change the mode accordng to the theme
      switchMode(theme);

      localStorage.setItem(STORAGE_KEY, theme);
    });
  }
})();
