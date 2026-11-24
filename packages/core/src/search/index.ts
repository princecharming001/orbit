/**
 * Network search (plan 32): imported as `@orbit/core/search` so its names stay apart from the rest of core. The
 * places table is a separate entry (`@orbit/core/search-places`) because it is large and loaded on demand.
 */

// the evidence rule, shared with role scoring (plan 44 §6.1)
export { foldQuote, verifyQuote } from '../roles/quote';
export * from './companies';
export * from './doc';
export * from './headline';
export * from './lint';
export * from './places';
export * from './predicates';
export * from './reading';
export * from './relax';
export * from './run';
export * from './schools';
export * from './spec';
export * from './titles';
export * from './ycoss';
