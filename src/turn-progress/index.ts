import { render } from '../card.js';
import { initialState, reduce } from '../reducer.js';

export default {
  schemaVersion: 1 as const,
  initialState,
  reduce,
  render,
};
