import Device056905, { type ModeTables } from './DHUM_056905_WW'

/**
 * LG Dehumidifier DHUM_231006_WW (deviceType 403, BEKEN_BK7234 module,
 * protocolVer 7 — a newer generation than the RTL8720cm the wiki documents).
 *
 * Shares the 056905 TLV map. Verified against the LG cloud's own decode of the
 * same unit while bridged, every field agreeing:
 *
 *   0x1f7 power             airState.operation 1        -> ON
 *   0x253 target humidity   tracked 45 / 55 / 65 exactly on each write
 *   0x1fa fan speed         airState.windStrength
 *   0x1f9 mode              airState.opMode
 *   ionizer / UVnano / bucket light matched airState.* one for one
 *
 * Only the two enums differ, so that is all this overrides.
 *
 * Labels are Korean because this model is sold in Korea and its panel, the LG
 * app, and the cloud integration all use these names — matching them keeps one
 * vocabulary across the local and cloud paths instead of inventing a second.
 *
 * Codes were measured by driving each option through the cloud integration and
 * reading back the corresponding airState field:
 *
 *   mode   Silent 19 · Intensive 20 · Quick 85 · Smart Plus 86
 *   fan    Mid 4 · High 6 · Turbo 7 · Auto 8
 *
 * 19/20 coincide with the 056905's Silent/Spot; 85/86 are where this model
 * diverges (056905 uses 21/17). There is no Jet equivalent here, so it is left
 * out rather than offered and silently rejected.
 *
 * Low = 2 is carried over from the 056905's `low`: a direct write of it read
 * back as 8, but only while in Smart Plus, where the appliance forces the fan
 * to automatic — so the read was the coercion, not the code. Worth re-checking
 * from a manual mode if Low ever misbehaves.
 */
export default class Device extends Device056905 {
    static modeTables: ModeTables = {
        haModes: ['Smart Plus', 'Silent', 'Intensive', 'Quick'],
        clipToHa: {
            19: 'Silent',
            20: 'Intensive',
            85: 'Quick',
            86: 'Smart Plus',
        },
        haToClip: {
            'Smart Plus': 86,
            Silent: 19,
            Intensive: 20,
            Quick: 85,
        },
        // Entering Silent drops the fan to its lowest setting, the same
        // behaviour the 056905 has for its silent mode.
        silent: new Set([19]),

        fanOptions: ['Auto', 'Low', 'Mid', 'High', 'Turbo'],
        fanToHa: { 2: 'Low', 4: 'Mid', 6: 'High', 7: 'Turbo', 8: 'Auto' },
        fanToClip: { Low: 2, Mid: 4, High: 6, Turbo: 7, Auto: 8 },
        lowFan: 'Low',
        lowFanClip: 2,

        // Five speeds, not the 056905's two. The base class used to hard-reject
        // anything but 2/6, which silently dropped Mid/Turbo/Auto writes.
        fanClipValues: new Set([2, 4, 6, 7, 8]),

        // The 056905 rewrites its whole per-mode fan-memory table on every fan
        // change. No capture shows this model doing that, and its mode codes are
        // different anyway (19/20/85/86 vs 17/18/20/21/22), so emitting that
        // table here would be inventing traffic. Send 0x1fa alone until a panel
        // capture says otherwise.
        fanPerMode: () => [],
    }
}
