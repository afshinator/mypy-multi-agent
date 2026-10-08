/**
 * Model pricing helpers: predicates used by budget accounting to decide
 * whether a model's usage is free of charge.
 */
/** True when a model has no catalog price (free). */
export type IsFreeModel = (model: string) => boolean;

/** A model whose input and output rates are both zero is free (tokens still count). */
export function isFreeCost(cost: { input: number; output: number }): boolean {
  return cost.input === 0 && cost.output === 0;
}
