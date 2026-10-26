/**
 * VADER valence (Hutto & Gilbert 2014; `vader-sentiment`, Apache-2.0) for reply rapport. Kept out of the core index
 * (`@orbit/core/vader`) so its 137 KB lexicon loads only where replies are read: the browser imports it on demand,
 * the server functions statically.
 */
/// <reference path="./vader-sentiment.d.ts" />
import vader from 'vader-sentiment';
import type { Valence } from './rapport';

export const vaderValence: Valence = (text: string) =>
  vader.SentimentIntensityAnalyzer.polarity_scores(text).compound;
