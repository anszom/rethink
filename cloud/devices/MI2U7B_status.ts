import crc16 from '@/util/crc16'

// Exact-model user-confirmed course labels; no nearby-model aliases.
export const COURSES: Readonly<Record<number, string>> = {
    46: 'Normal',
    85: 'TubClean',
    100: 'Intimates',
    33: 'Hand Wash',
    55: 'Rinse+Spin',
    255: 'Downloaded',
}

export type SideKickUpdate =
    | { kind: 'status'; course: string; status: string; remaining_time: number | undefined; energy: number }
    | { kind: 'drawer'; drawer: 'ON' | 'OFF' | undefined }

// MI2U7B complete long frames only. The short-frame checksum is not its CRC.
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
        // Only Standby and the physically observed TubClean Rinsing context are
        // established. Off/Washing/Spinning/Finished remain excluded guesses.
        const status = payload[21] === 1 ? 'Standby' : payload[5] === 85 && payload[21] === 12 ? 'Rinsing' : 'Unknown'
        return {
            kind: 'status',
            course: COURSES[payload[5]] ?? 'Unknown',
            status,
            remaining_time: payload[21] === 1 ? undefined : payload.readUInt16LE(14),
            // User-selected Wh interpretation; calibration remains unverified.
            energy: payload.readUInt16BE(17),
        }
    }
    // Reversible drawer-out/in observation, not an inner-lid or drum-door sensor.
    if (frame[12] === 0x03 && payloadLength === 15)
        return { kind: 'drawer', drawer: payload[14] === 1 ? 'ON' : payload[14] === 0 ? 'OFF' : undefined }

    // No completion signature, total-time candidates, option guesses or raw
    // diagnostic fields: these do not have verified exact-model semantics.
}
