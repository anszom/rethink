// Connects to the official LG ThinQ cloud (logging in interactively on first run)
// and prints the real-time MQTT notifications it emits about your devices. Useful for
// understanding how the cloud interprets device updates. The country code and OAuth
// refresh token are persisted to oauth.json and reused by other tools (e.g.
// rethink-capture.ts); the subscription is regenerated at runtime. On the first run the
// login prompts for the country code interactively.

import { connect, login, type CloudMessage } from '@/util/lgcloud/monitor'
import { loadState, saveState } from '@/util/lgcloud/state'

function printMessage({ topic, payload, raw }: CloudMessage) {
    console.log('mqtt: message topic=', topic)
    console.log(payload !== null ? JSON.stringify(payload, null, 2) : `(non-json payload): ${raw}`)
}

async function run() {
    let state = loadState()
    if (!state) {
        state = await login()
        saveState(state)
    }
    await connect(state, { onMessage: printMessage, log: (m) => console.log(`mqtt: ${m}`) })
}

run()
