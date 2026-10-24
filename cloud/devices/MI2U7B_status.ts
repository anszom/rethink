import crc16 from '@/util/crc16'

// Exact-model course codes confirmed by the user.
export const COURSES = {
    46: 'Normal',
    85: 'TubClean',
    100: 'Intimates',
    33: 'Hand Wash',
    55: 'Rinse+Spin',
    255: 'Downloaded',
} as const
// State labels; unknown codes keep their numeric fallback.
export const STATES = {
    0: 'Off',
    1: 'Standby',
    2: 'Pause',
    3: 'Detecting',
    5: 'Add drain',
    6: 'Detergent amount',
    7: 'Reserved',
    8: 'Soak',
    9: 'Pre-wash',
    11: 'Washing',
    12: 'Rinsing',
    13: 'Rinse hold',
    14: 'Spinning',
    15: 'Drying',
    16: 'Finished',
    21: 'Refreshing',
    23: 'Error auto off',
    27: 'Frozen prevent initial',
    28: 'Frozen prevent pause',
    29: 'Frozen prevent running',
    34: 'Audible diagnosis',
    35: 'Auto DT open pause',
    36: 'Confirm start for control',
    37: 'Clothing recognition',
    38: 'Detergent input',
    39: 'Softener input',
    40: 'Pollution detecting',
    41: 'Tub cleaning',
    42: 'End remote maintain on',
    43: 'Steam',
    47: 'Laundry care',
    48: 'EZDispense cleaning',
    52: 'Dry cooling',
} as const

export type SideKickUpdate =
    | {
          kind: 'status'
          course: string
          status: string
          remaining_time: number | undefined
          state_code: number
          total_time: number
          energy: number
      }
    | { kind: 'drawer'; drawer: 'ON' | 'OFF' | undefined }
    | { kind: 'completion' }

// MI2U7B only: complete long wire frames, not checksum-stripped packet bodies.
export function parseSideKickFrame(frame: Buffer): SideKickUpdate | undefined {
    if (
        frame.length < 18 ||
        frame[0] !== 0xaa ||
        frame[1] !== 0xff ||
        frame[2] !== 0x20 ||
        frame[3] !== 0x0a ||
        frame[frame.length - 1] !== 0xbb ||
        frame.readUInt16BE(4) !== frame.length
    )
        return

    const payloadLength = frame.readUInt16BE(13)
    if (payloadLength + 18 !== frame.length) return
    if (crc16(frame.subarray(0, frame.length - 3)) !== frame.readUInt16BE(frame.length - 3)) return
    const payload = frame.subarray(15, frame.length - 3)

    if (frame[12] === 0xeb && payloadLength === 49 && payload[0] === 0) {
        const course = (COURSES as Readonly<Record<number, string>>)[payload[5]]
        // Keep state names consistent across courses.
        const status = (STATES as Readonly<Record<number, string>>)[payload[21]]
        return {
            kind: 'status',
            course: course ?? `Program ${payload[5]}`,
            status: status ?? `Status ${payload[21]}`,
            // Fresh Off/Standby reports hide stale estimates; captured values remain unchanged.
            remaining_time: [0, 1].includes(payload[21])
                ? undefined
                : payload[5] === 85 && payload[21] === 16
                  ? 0
                  : payload.readUInt16LE(14),
            state_code: payload[21],
            // Total Time stayed fixed during the observed countdown.
            total_time: payload.readUInt16LE(16),
            // Energy shares byte17 with Total Time; retain both field decodings.
            energy: payload.readUInt16BE(17),
        }
    }
    // Completion notification observed in the TubClean cycle.
    // Do not also treat the earlier 55-byte packet as completion.
    if (
        frame[12] === 0x03 &&
        payloadLength === 99 &&
        payload.subarray(0, 5).equals(Buffer.from([0x0c, 0x0b, 0x01, 0x08, 0x0c]))
    )
        return { kind: 'completion' }
    // Only the reversible drawer event is verified. Other 03 lengths (including
    // 73 bytes) and inner-lid position have no established interpretation.
    if (frame[12] === 0x03 && payloadLength === 15) {
        return { kind: 'drawer', drawer: payload[14] === 1 ? 'ON' : payload[14] === 0 ? 'OFF' : undefined }
    }
}
