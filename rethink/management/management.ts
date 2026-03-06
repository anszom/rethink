import { WebSocketExpress, ExtendedWebSocket } from 'websocket-express';

import path from 'path';
import { fileURLToPath } from 'url';
import log from '../util/logging.js';

import HA_bridge from '../cloud/ha_bridge.js'
import { AnyDevice, DeviceManager } from '../cloud/devmgr.js';
import { Bridge } from '../bridge/bridge.js';
import { Request, Response } from 'express';

export function app(ha: HA_bridge, manager: DeviceManager, bridge: Bridge | undefined) {
    const app = new WebSocketExpress()
    let subscribers: ExtendedWebSocket[] = []

    // device management
    function broadcast(message: object) {
        const str = JSON.stringify(message)
        subscribers.forEach((sub) => {
            sub.send(str)
        })
    }

    function statusReport(message: string) {
        broadcast({ status: message })
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
                bridge: bridgeStatus(),
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
                deviceType: meta.deviceType,
                platform: dev.platform,
                mapped: ha.haDevices.has(id),
                bridged: bridge ? bridge.status(id) : false
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

    if(bridge) {
        app.get('/thinq_login', asyncHandler(async (req, res) => {
            res.redirect((await bridge.beginLogin({countryCode: req.query.countryCode as string})).toString())
        }))

        app.post('/thinq_login_accept', asyncHandler(async (req, res) => {
            const url = `${req.body.url}`
            const countryCode = `${req.body.countryCode}`
            if(await bridge.completeLogin({countryCode}, new URL(url))) {
                res.statusCode = 200;
                res.end();
            } else {
                res.statusCode = 400;
                res.end();
            }
        }))

        app.post('/thinq_logout', asyncHandler(async (req, res) => {
            await bridge.logout()
            res.end()
        }))

        app.post('/bridge/:deviceId/enable', asyncHandler(async (req, res) => {
            const deviceType = typeof(req.body.deviceType) === 'string' ? req.body.deviceType as string : undefined
            try {
                if(await bridge.enable(req.params.deviceId, deviceType, statusReport))
                    res.status(204).end()
                else
                    res.status(400).end()

            } catch(err) {
                res.status(500).end(err.toString())
            }
        }))

        app.post('/bridge/:deviceId/disable', asyncHandler(async (req, res) => {
            await bridge.disable(req.params.deviceId)
            res.status(204).end()
        }))

        function refreshBridgeStatus() {
            broadcast({ bridge: bridgeStatus() })
        }

        bridge.on('loggedIn', refreshBridgeStatus)
        bridge.on('loggedOut', refreshBridgeStatus)
        bridge.on('started', refreshDevices)
        bridge.on('stopped', refreshDevices)
    }

    function bridgeStatus() {
        if(bridge)
            return { loggedIn: bridge.isLoggedIn() }
    }

    // static pages
    app.use(WebSocketExpress.static(currentDir + '/../html', { extensions: ['html'] }))
    return app.createServer()
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<any>) {
    return (req, res, next) => {
        handler(req, res).catch(next)
    }
}