import * as tls from 'node:tls'
import * as mtosp from './util/mtosp.js'

const [host, wifiname, wifipass] = process.argv.slice(2)

console.log(`Connecting to ${host}:5500`)

async function request(xml: string) {
    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const socket = tls.connect({host: host, port: 5500, rejectUnauthorized: false }, () => resolve(socket))
        socket.on('error', reject)
    })

    socket.write(mtosp.format(xml))

    const result = await new Promise<string>((resolve, reject) => {
        socket.on('error', reject)

        const splitter = mtosp.splitter()
        socket.on('data', (data) => {
            try {
                for(const byte of data)
                    splitter(byte, resolve)
            } catch(err) {
                reject(err)
            }
        })
    })

    socket.destroy()
    return result
}

(async () => {
    console.log('Request: deviceinfo')
    let resp = await request(`<mTosp><data type="deviceinfo"><time>${Date.now()}</time><reg>000</reg><errorCode>N</errorCode></data></mTosp>`)
    console.log('response:', resp)
    const b64ssid = Buffer.from(wifiname, 'utf-8').toString('base64')
    const b64password = Buffer.from(wifipass, 'utf-8').toString('base64')
    
    console.log('Request: deviceinfo')
    resp = await request(`<mTosp><data type="apinfo"><format>B64</format><bssid>${b64ssid}</bssid><security>WPA_PSK</security><password>${b64password}</password><subCountryCode>PL</subCountryCode><regionalCode>eic</regionalCode></data></mTosp>`)
    console.log('response:', resp)
})()