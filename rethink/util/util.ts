// works around "Object literal may only specify known properties" while maintainig type safety
export function allowExtendedType<T, Q extends T>(t: Q): T {
    return t;
}
