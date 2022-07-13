/** @internal */
export const empty = Symbol()
/** @internal */
export type empty = typeof empty
/** @internal */
export const namespace = Symbol()
/** @internal */
export const ambiguous = Symbol()
/** @internal */
export const all = Symbol()
/** @internal */
export const allButDefault = Symbol()

/** @internal */
export type PromiseCapability<T> = {
    readonly Promise: Promise<T>
    readonly Reject: (reason: unknown) => void
    readonly Resolve: (val: T) => void
    Status:
        | { Type: 'Pending'; Promise: Promise<T> }
        | { Type: 'Fulfilled'; Value: T }
        | { Type: 'Rejected'; Reason: unknown }
}
/** @internal */
export function PromiseCapability<T>(): PromiseCapability<T> {
    let ok: any, err: any
    const promise = new Promise<T>((a, b) => {
        ok = (val: T) => {
            capability.Status = { Type: 'Fulfilled', Value: val }
            a(val)
        }
        err = (error: unknown) => {
            capability.Status = { Type: 'Rejected', Reason: error }
            b(error)
        }
    })
    const capability: PromiseCapability<T> = {
        Promise: promise,
        Resolve: ok!,
        Reject: err!,
        Status: { Type: 'Pending', Promise: promise },
    }
    return capability
}
