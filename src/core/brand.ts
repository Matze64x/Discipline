declare const brand: unique symbol;

/**
 * A nominal ("branded") type: structurally a `T`, but not assignable from a plain `T`.
 * Values can only be created through the constructor functions of the respective module,
 * which validate them. Example: a plain `number` can't be passed where `Cents` is expected.
 */
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };
