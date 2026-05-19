// The `real` field on `proxy.proxy` can decode in several shapes depending on the
// runtime / pallet config:
//   - MultiAddress: { type: 'Id' | 'Address20' | 'Raw' | ..., value: string | bytes }
//   - Bare AccountId32 string (when the pallet uses AccountId directly, not Lookup)
//
// Anywhere we reach into `decodedCall.value.value.real` we must tolerate both
// forms; otherwise we crash with `Cannot read properties of undefined (reading '...')`
// on nested proxy.proxy renders.
export const getRealAccount = (real: unknown): string | undefined => {
    if (!real) return undefined;
    if (typeof real === 'string') return real;
    if (typeof real === 'object') {
        const candidate = (real as { value?: unknown }).value;
        if (typeof candidate === 'string') return candidate;
    }
    return undefined;
};
