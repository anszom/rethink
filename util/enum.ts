/**
 * One label may be declared with several codes. Appliances sometimes report a single setting under
 * more than one number - and all of them have to read back as the same label. The first code is the one
 * writes use.
 */
export type EnumCodes = number | readonly number[]

/**
 * A bidirectional map between the numeric codes an appliance speaks and the labels published to
 * Home Assistant.
 *
 * Declared label-first, because the labels are the half that has to stay stable: they are what HA
 * shows, and for a writable entity they are also the option list it offers, which `options` hands
 * over ready to use.
 *
 */
export class Enum<ValueType extends string> {
    readonly forward: Record<number, ValueType> = Object.create(null)
    readonly inverse: Record<ValueType, number> = Object.create(null)

    /** The labels, deduplicated by construction — an HA `options` list. */
    readonly options: ValueType[]

    constructor(entries: [ValueType, EnumCodes][]) {
        this.options = entries.map(([label]) => label)

        for (const [label, code] of entries) {
            const [primary, ...aliases] = typeof code === 'number' ? [code] : code
            if (primary === undefined) continue // a label declared with no code at all
            this.inverse[label] = primary
            this.forward[primary] = label
            for (const alias of aliases) this.forward[alias] = label
        }
    }

    /**
     * The common case, where the table reads better as an object literal.
     *
     * Note that this hands the label order to JavaScript's own key order, so integer-like labels
     * ('1', '2') come first, ascending, ahead of everything else regardless of where they were
     * written. Where `options` has to come out in a particular order, pass entries to the
     * constructor instead.
     */
    static of<ValueType extends string>(codes: Record<ValueType, EnumCodes>) {
        return new Enum(Object.entries(codes) as [ValueType, EnumCodes][])
    }

    map(input: number): ValueType | undefined {
        return this.forward[input]
    }

    unmap(input: string): number | undefined {
        return this.inverse[input as ValueType]
    }
}
