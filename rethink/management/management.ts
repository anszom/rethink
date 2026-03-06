import { WebSocketExpress, ExtendedWebSocket } from 'websocket-express';

import path from 'path';
import { fileURLToPath } from 'url';
import log from '../util/logging.js';

import HA_bridge from '../cloud/ha_bridge.js'
import { AnyDevice, DeviceManager } from '../cloud/devmgr.js';

export function app(ha: HA_bridge, manager: DeviceManager) {
    const app = new WebSocketExpress()
    let subscribers: ExtendedWebSocket[] = []

    // device management
    function broadcast(message: object) {
        const str = JSON.stringify(message)
        subscribers.forEach((sub) => {
            sub.send(str)
        })
    }

    app.use(function(req, res, next) {
        log('MGMT', req.hostname, req.url)
        next()
    })
    app.use(WebSocketExpress.json())

    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    app.ws('/ws', (req, res, next) => {
        res.accept().then((ws) => {
            subscribers.push(ws)

            ws.send(JSON.stringify({
                ha: ha.HA.isConnected,
                devices: enumDevices()
            }))

            ws.on('message', (msg) => {
            })

            ws.on('close', () => {
                subscribers = subscribers.filter((el) => el !== ws)
            })
        }, next)
    })

    ha.HA.on('statusChanged', (ha) => {
        broadcast({ ha })
    })

    function enumDevices() {
        const allDevices: Record<string,any> = {}
        for(const id in manager.allDevices) {
            const dev = manager.allDevices[id]
            const meta = dev.meta
            allDevices[id] = {
                model: meta.modelId,
                platform: dev.platform,
                mapped: ha.haDevices.has(id),
             }
        }
        return allDevices
    }

    function refreshDevices() {
        broadcast({ devices: enumDevices() })
    }

    function onNewDevice(dev: AnyDevice) {
        refreshDevices()
    }

    manager.on('newDevice', onNewDevice)
    manager.on('dropDevice', refreshDevices)

    // static pages
    app.use(WebSocketExpress.static(currentDir + '/../html', { extensions: ['html'] }))
    return app.createServer()
}