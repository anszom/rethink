import * as mqtt from 'mqtt'

if (process.argv.length < 7) {
    console.warn(
        `Usage:
	tsx packet-sender-device.ts mqtt-hostname[:port] device-uuid cmd type data
`,
    )
    process.exit()
}

const [mqttHostname, deviceId, cmd, type, data] = process.argv.slice(2)
const messagestr = JSON.stringify({
    did: deviceId,
    mid: Date.now(),
    cmd: cmd,
    type: Number(type),
    data: JSON.parse(data),
})
console.log(messagestr)

const client = mqtt.connect('mqtt://' + mqttHostname)

client.on('connect', () => {
    client.publish('lime/devices/' + deviceId, messagestr + ' ')
    client.end()
})
