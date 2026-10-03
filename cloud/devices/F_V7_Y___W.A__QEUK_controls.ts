import type { ComponentInfo } from '../homeassistant'

export default class WasherControls {
    private record?: Buffer
    private connected = true

    constructor(
        private readonly send: (inner: Buffer) => void,
        private readonly knownCourse: (record: Buffer) => boolean,
    ) {}

    get components(): Record<string, ComponentInfo> {
        const button = (key: string, name: string, icon: string) => ({
            platform: 'button',
            name,
            icon,
            unique_id: `$deviceid-${key}`,
            command_topic: `$this/${key}/set`,
            payload_press: 'PRESS',
        })
        return {
            start: button('start', 'Start', 'mdi:play-circle-outline'),
            pause: button('pause', 'Pause', 'mdi:pause-circle-outline'),
            resume: button('resume', 'Resume', 'mdi:play-pause'),
            wake_up: button('wake_up', 'Wake up', 'mdi:sleep-off'),
            power_off: button('power_off', 'Power off', 'mdi:power'),
        }
    }

    setRecord(record: Buffer) {
        this.record = Buffer.from(record)
    }

    drop() {
        this.record = undefined
        this.connected = false
    }

    setProperty(key: string, value: string) {
        if (!this.connected || value !== 'PRESS') return
        if (key === 'wake_up') return this.send(Buffer.from('f02a0100', 'hex'))
        if (key === 'pause') return this.send(Buffer.from('f024040100', 'hex'))
        if (key === 'power_off') return this.send(Buffer.from('f024010100', 'hex'))
        if (key !== 'start' && key !== 'resume') return

        const r = this.record
        // Validate the encoding and programme, not the appliance's safety interlocks.
        // Never invent settings or reuse a snapshot from an earlier connection.
        if (!r || !this.validCurrentSettings(r)) {
            console.warn('WV5-1275W: waiting for a supported current programme before Start/Resume')
            return
        }
        const settings = Buffer.alloc(16)
        settings[0] = r[7] // base course
        settings[1] = r[9] // wash mode
        settings[2] = r[10] // spin
        settings[3] = r[11] // temperature
        settings[4] = r[12] // rinse
        settings[9] = r[16] // pre-wash, medic rinse and steam
        settings[12] = r[22] // active downloaded course
        // LG Start uses initialBit + remoteStart; Resume uses only remoteStart.
        // The captured HA Start also echoed doorLock (0x43); use LG's 0x03 flags.
        settings[10] = key === 'start' ? 3 : 2
        if (key === 'resume') {
            settings[6] = r[14]
            settings[7] = r[15]
        }
        this.send(Buffer.concat([Buffer.from([0xf0, 0x26]), settings]))
    }

    private validCurrentSettings(r: Buffer) {
        return (
            this.knownCourse(r) &&
            r[9] <= 4 &&
            r[10] <= 11 &&
            r[11] <= 7 &&
            r[12] <= 5 &&
            r[13] === 0 &&
            (r[16] & ~0xd0) === 0 &&
            r[14] <= 19 &&
            r[15] <= 59
        )
    }
}
