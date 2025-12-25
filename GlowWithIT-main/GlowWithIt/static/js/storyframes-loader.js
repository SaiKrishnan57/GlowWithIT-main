/**
 * This javascript file is used for loading and caching the story frame definitions from the storyFrames.json
 * And an in-memory cache to improve performance
 * throws an exception message if the json file failed to load
 */
let cacheStoryJson = null;

export async function loadStoryLineFrames(url = '/static/json/storyFrames.json') {

  // returns the cached json file if finds it
  if (cacheStoryJson){

    return cacheStoryJson;
  }

  const response = await fetch(url, { cache: 'no-store' });

  if (!response.ok){

    throw new Error(`Failed to load story frames: ${response.status}`);
  }

  cacheStoryJson = await response.json();

  return cacheStoryJson;
}
