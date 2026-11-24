import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';
import { forgetScrolls, forgetViews } from '../state/viewState';

// what a page keeps while it is off the screen belongs to one visit: a test starts with none of it
afterEach(() => {
  forgetViews();
  forgetScrolls();
});
