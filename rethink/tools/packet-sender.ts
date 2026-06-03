import * as TLV from '../util/tlv'
import crc16 from '../util/crc16'
import * as mqtt from 'mqtt'

if (process.argv.length < 9) {
    console.warn(
        `Usage:
	tsx packet-sender.ts mqtt-hostname[:port] device-uuid a_value s_value byte5 byte6 byte7 [t1 v1] [t2 v2] [...]

	a_value, s_value - see https://github.com/anszom/rethink/wiki/CloudProtocol#packet
	byte5, byte6, byte7 - see https://github.com/anszom/rethink/wiki/UartProtocol#framing-format
	tX,vX - TLV attributes
`,
    )
    process.exit()
}

const [mqttHostname, deviceId, ...numbers] = process.argv.slice(2)
const [b0, b1, b2, b3, b4] = numbers.map(Number)

let tlv: TLV.TLV[] = []
for (var i = 5; i + 1 < numbers.length; i += 2) tlv.push({ t: Number(numbers[i]), v: Number(numbers[i + 1]) })
let tlvArray = TLV.build(tlv)
let buf = [0x04, 0x00, 0x00, 0x00, 0x65, b2, b3, b4, tlvArray.length].concat(tlvArray)
let result = crc16(buf)

buf = [b0, b1].concat(buf, [result >> 8, result & 0xff])
const messagestr = JSON.stringify({
    did: deviceId,
    mid: Date.now(),
    cmd: 'packet',
    type: 1,
    data: Buffer.from(buf).toString('hex'),
})
console.log(messagestr)

const client = mqtt.connect('mqtt://' + mqttHostname)

client.on('connect', () => {
    client.publish('lime/devices/' + deviceId, messagestr + ' ')
    client.end()
})
