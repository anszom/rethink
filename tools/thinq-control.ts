// Drive a ThinQ2 device through the official LG cloud, the way the LG app does, so that the
// cloud's translation of airState.* names into device wire values can be observed (e.g. with
// the management /device monitor while the device is bridged). Uses the oauth.json login
// created by tools/lgcloud-monitor.ts.
//
//   npx tsx tools/thinq-control.ts status <deviceId>
//   npx tsx tools/thinq-control.ts set <deviceId> <ctrlKey> <dataKey> <value> [<dataKey> <value> ...]
//
// Diagnostics go to stderr; stdout carries the JSON result only.

import { Client, apiFetch } from '@/bridge/thinqApi'
import { loadState } from '@/util/lgcloud/state'

console.log = console.error

async function main() {
    const [cmd, deviceId, ...rest] = process.argv.slice(2)
    const state = loadState()
    if (!state) throw new Error('not logged in; run `npx tsx tools/lgcloud-monitor.ts` once')
    if (!deviceId) throw new Error('usage: status|set <deviceId> ...')

    const client = new Client({ countryCode: state.countryCode })
    await client.auth(state.refreshToken)
    const { thinq2Uri } = await client.gateway

    if (cmd === 'status') {
        const out = await apiFetch(`${thinq2Uri}/service/devices/${deviceId}`, { headers: client.headers })
        process.stdout.write(JSON.stringify(out, null, 1) + '\n')
        return
    }

    if (cmd === 'set') {
        const [ctrlKey, ...pairs] = rest
        if (!ctrlKey || pairs.length < 2 || pairs.length % 2) throw new Error('set needs ctrlKey and key/value pairs')
        const keys: string[] = []
        const values: (string | number)[] = []
        for (let i = 0; i < pairs.length; i += 2) {
            keys.push(pairs[i])
            values.push(/^-?\d+(\.\d+)?$/.test(pairs[i + 1]) ? Number(pairs[i + 1]) : pairs[i + 1])
        }
        const body =
            keys.length === 1
                ? { ctrlKey, command: 'Set', dataKey: keys[0], dataValue: values[0] }
                : { ctrlKey, command: 'Set', dataKeyList: keys, dataValueList: values }
        const out = await apiFetch(`${thinq2Uri}/service/devices/${deviceId}/control-sync`, {
            headers: client.headers,
            method: 'POST',
            body: JSON.stringify(body),
        })
        process.stdout.write(JSON.stringify({ sent: body, result: out }) + '\n')
        return
    }

    throw new Error(`unknown command ${cmd}`)
}

main().catch((err) => {
    console.error(`${err}`)
    process.exit(1)
})
