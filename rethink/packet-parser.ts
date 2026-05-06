import * as TLV from './util/tlv'
import crc16 from './util/crc16'
import * as mqtt from 'mqtt'

if (process.argv.length === 4 && (process.argv[2] === '-message' || process.argv[2] === '-message-raw')) {
    const raw = process.argv[2] === '-message-raw'
    const buf = Buffer.from(process.argv[3], 'hex')
    if (crc16(buf.subarray(raw ? 0 : 2)) != 0) console.warn('CRC16 mismatch!')

    const start = raw ? 8 : 10
    const len = buf[start]
    TLV.parse(buf.subarray(start + 1, start + 1 + len)).forEach((el) => {
        console.log(
            't=0x' + el.t.toString(16),
            'l=' + el.l?.toString(10),
            'v=0x' + el.v.toString(16) + ' (' + el.v.toString(10) + ')',
        )
    })
    process.exit()
}

if (process.argv.length !== 4) {
    console.warn(
        `Usage:
	tsx packet-parser.ts mqtt-hostname[:port] device-uuid
	tsx packet-parser.ts [-message|-message-raw] HEX-STRING
`,
    )
    process.exit()
}

const [mqttHostname, deviceId] = process.argv.slice(2)

const client = mqtt.connect('mqtt://' + mqttHostname)

client.on('connect', () => {
    var msgtopic
    var mid = 10000
    client.on('message', (topic, message, packet) => {
        if (topic === 'clip/message/devices/' + deviceId) {
            const payload = JSON.parse(message.subarray(0, message.length - 1).toString('utf-8'))
            if (payload.cmd === 'device_packet') {
                console.log(Date.now(), payload.data)
                const buf = Buffer.from(payload.data, 'hex')
                try {
                    if (crc16(buf.subarray(2)) != 0) console.warn('CRC16 mismatch!')
                    const len = buf[10]
                    TLV.parse(buf.subarray(11, 11 + len)).forEach((el) => {
                        console.log(
                            't=0x' + el.t.toString(16),
                            'l=' + el.l?.toString(10),
                            'v=0x' + el.v.toString(16) + ' (' + el.v.toString(10) + ')',
                        )
                    })
                } catch (err) {
                    console.log(err)
                }
            }
        }
    })

    client.subscribe('clip/message/devices/' + deviceId)
})
